/**
 * Cached copies (`{ at, value }`) kept light on KV writes. Workers Free allows 1,000 KV writes a
 * day per account, shared by every Worker in it, so a refresh lands in this isolate's memory first
 * and reaches KV only when it says something new: a copy whose value changed (after `minGap`), or
 * one whose KV twin is older than `maxGap`, so other isolates and the next deploy still find a
 * recent copy. A failed write (the daily cap reached: 429) is logged and never fails the request.
 *
 * The Cache API would be the natural hot layer, but it is not available to a Worker behind Access.
 */
import type { Env } from './env';

export interface Copy<T> {
  at: number;
  value: T;
}

export interface PutRule {
  /** A changed value waits this long after the KV copy before it is written (usage: 30 min). */
  minGap?: number;
  /** An unchanged value is written again once the KV copy is this old, so its `at` stays recent. */
  maxGap: number;
  expirationTtl?: number;
}

/** Newer than KV's copy: what this isolate refreshed but didn't write. */
const mem = new Map<string, Copy<unknown>>();
/** The KV copy's `at` and value as last read or written here, to tell what a write would change. */
const kvSeen = new Map<string, { at: number; json: string }>();

/**
 * The newest copy: this isolate's own when it's newer than KV's. A key gone from KV (deleted to
 * forget it) is gone here too.
 */
export async function getCopy<T>(env: Env, key: string): Promise<Copy<T> | null> {
  const raw = await env.KV.get(key);
  if (raw === null) {
    mem.delete(key);
    kvSeen.delete(key);
    return null;
  }
  const kv = JSON.parse(raw) as Copy<T>;
  kvSeen.set(key, { at: kv.at, json: JSON.stringify(kv.value) });
  const hot = mem.get(key) as Copy<T> | undefined;
  if (hot && hot.at > kv.at) return hot;
  mem.delete(key);
  return kv;
}

/** Forgets this isolate's copy after a write that went straight to KV. */
export function dropHot(key: string) {
  mem.delete(key);
  kvSeen.delete(key);
}

/** Keeps `value` as the newest copy; writes KV only when the rule says it's worth a write. */
export async function putCopy<T>(env: Env, key: string, value: T, rule: PutRule): Promise<void> {
  const now = Date.now();
  const json = JSON.stringify(value);
  const seen = kvSeen.get(key);
  const age = seen ? now - seen.at : Number.POSITIVE_INFINITY;
  const changed = !seen || seen.json !== json;
  if ((changed && age >= (rule.minGap ?? 0)) || age >= rule.maxGap) {
    const ok = await quietPut(env, key, JSON.stringify({ at: now, value } satisfies Copy<T>), {
      expirationTtl: rule.expirationTtl,
    });
    if (ok) {
      kvSeen.set(key, { at: now, json });
      mem.delete(key);
      return;
    }
  }
  mem.set(key, { at: now, value });
}

/** A KV write that only logs when it fails (the daily cap, a timeout): a cache must never break a reply. */
export async function quietPut(env: Env, key: string, value: string, opts?: KVNamespacePutOptions) {
  try {
    await env.KV.put(key, value, opts?.expirationTtl ? opts : undefined);
    return true;
  } catch (e) {
    console.error(`KV put ${key}:`, e);
    return false;
  }
}

/** Writes `value` unless KV already holds exactly it (`prev` is what was read). */
export async function putIfChanged(
  env: Env,
  key: string,
  value: string,
  prev: string | null,
  opts?: KVNamespacePutOptions,
) {
  if (value === prev) return true;
  return quietPut(env, key, value, opts);
}

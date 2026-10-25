/**
 * Which accounts the Settings tokens reach, and each account's usage, cached in KV so a page load
 * doesn't re-read Cloudflare. One account per request keeps every call well inside the Worker's
 * subrequest limit.
 *
 * KV: `accounts:v1` → AccountRef[] (10 min), `usage:v1:<account>` → { account, resources } (10 min),
 * `prefs:v1`, `labels:v1`, `view:v1:<page>` → the person's settings, labels and saved page layouts.
 */
import type { LabelsDoc, Prefs } from '../shared/catalog';
import { historyDates, listAccounts, readAccount } from './cloudflare';
import type { Env } from './env';
import { listSecrets, revealSecret } from './secrets';

const TTL_MS = 10 * 60_000;

export interface AccountRef {
  id: string;
  name: string;
  token: string;
  tokenLabel: string;
}

interface Cached<T> {
  at: number;
  value: T;
}

async function cached<T>(env: Env, key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  if (!fresh) {
    const hit = await env.KV.get<Cached<T>>(key, 'json');
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  }
  const value = await load();
  await env.KV.put(key, JSON.stringify({ at: Date.now(), value } satisfies Cached<T>), {
    expirationTtl: 86_400,
  });
  return value;
}

/** Every account any token can read; the first token (by label) that reaches an account reads it. */
export async function accountRefs(env: Env, fresh: boolean) {
  return cached(env, 'accounts:v1', fresh, async () => {
    const accounts: AccountRef[] = [];
    const errors: { token: string; label: string; error: string }[] = [];
    for (const s of await listSecrets(env)) {
      try {
        const token = await revealSecret(env, s.name);
        if (!token) continue;
        for (const a of await listAccounts(token)) {
          if (!accounts.some((x) => x.id === a.id)) {
            accounts.push({ id: a.id, name: a.name, token: s.name, tokenLabel: s.label });
          }
        }
      } catch (e) {
        errors.push({ token: s.name, label: s.label, error: e instanceof Error ? e.message : 'Failed' });
      }
    }
    return { accounts, errors };
  });
}

export async function accountUsage(env: Env, accountId: string, fresh: boolean) {
  const { accounts } = await accountRefs(env, false);
  const ref = accounts.find((a) => a.id === accountId);
  if (!ref) return null;
  const prefs = await getPrefs(env);
  const key = `usage:v1:${accountId}`;
  // A plan change in Settings must show at once, so it's part of what the cache is checked against.
  const hit = fresh ? null : await env.KV.get<Cached<Awaited<ReturnType<typeof readAccount>>>>(key, 'json');
  const want = prefs.plans[accountId];
  if (
    hit &&
    Date.now() - hit.at < TTL_MS &&
    (want ? hit.value.account.plan === want : hit.value.account.planSource !== 'set')
  ) {
    return { dates: historyDates(new Date(hit.at)), ...hit.value };
  }
  return cached(env, key, true, async () => {
    const token = await revealSecret(env, ref.token);
    if (!token) throw new Error('Token missing');
    return readAccount(token, { ...ref, planOverride: want }, historyDates());
  }).then((v) => ({ dates: historyDates(), ...v }));
}

// ---------- The person's settings, labels and layouts ----------

const DEFAULT_PREFS: Prefs = { warn: 75, plans: {} };

export async function getPrefs(env: Env): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...(await env.KV.get<Prefs>('prefs:v1', 'json')) };
}
export const putPrefs = (env: Env, p: Prefs) => env.KV.put('prefs:v1', JSON.stringify(p));

export async function getLabels(env: Env): Promise<LabelsDoc> {
  return (await env.KV.get<LabelsDoc>('labels:v1', 'json')) ?? { labels: [], assign: {} };
}
export const putLabels = (env: Env, l: LabelsDoc) => env.KV.put('labels:v1', JSON.stringify(l));

export const getView = (env: Env, page: string) => env.KV.get<unknown>(`view:v1:${page}`, 'json');
export const putView = (env: Env, page: string, config: unknown) =>
  env.KV.put(`view:v1:${page}`, JSON.stringify(config));
export const deleteView = (env: Env, page: string) => env.KV.delete(`view:v1:${page}`);

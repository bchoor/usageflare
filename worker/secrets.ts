/**
 * Secrets the person enters in Settings, kept in KV encrypted with AES-GCM under SETTINGS_KEY.
 * The key name is the additional data, so a ciphertext can't be moved to another name.
 * Plaintext never leaves the Worker: the API lists names, last four characters and test results.
 *
 * KV layout: `secret:<name>` → StoredSecret (JSON); `test:<name>` → KeyTest, kept apart so a slow
 * test can never write an old ciphertext back over a replace or a delete.
 */
import { listAccounts, REST_MS } from './cloudflare';
import type { Env } from './env';

export interface KeyTest {
  at: string;
  ok: boolean;
  detail?: string | null;
  error?: string | null;
  /** Accounts the token reaches, and of those, how many let it read tags (Account › Tag). */
  accounts?: number;
  tagAccounts?: number;
}

interface StoredSecret {
  v: 1;
  /**
   * `cf_api_token` reads usage and, with Account › Tag › Edit, writes tags too. `cf_tags_token` was
   * a tags-only token; ones saved before still write tags but aren't offered any more.
   */
  kind: 'cf_api_token' | 'cf_tags_token';
  label: string;
  iv: string;
  ct: string;
  last4: string;
  updatedAt: string;
  updatedBy: string;
}

export type SecretInfo = Pick<StoredSecret, 'kind' | 'label' | 'last4' | 'updatedAt' | 'updatedBy'> & {
  name: string;
  test: KeyTest | null;
};

const PREFIX = 'secret:';
const TEST = 'test:';
const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.SETTINGS_KEY ? unb64(env.SETTINGS_KEY) : new Uint8Array();
  if (raw.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const info = (name: string, s: StoredSecret, test: KeyTest | null): SecretInfo => ({
  name,
  kind: s.kind,
  label: s.label,
  last4: s.last4,
  updatedAt: s.updatedAt,
  updatedBy: s.updatedBy,
  test,
});

async function read(env: Env, name: string) {
  return env.KV.get<StoredSecret>(PREFIX + name, 'json');
}

/**
 * The secret names, kept in one key: KV `list()` can lag a write by up to a minute, so a token
 * just added wouldn't show. Merged with `list()` so names saved before the index still appear.
 */
const INDEX = 'secrets:index';
async function names(env: Env): Promise<string[]> {
  const [index, { keys }] = await Promise.all([
    env.KV.get<string[]>(INDEX, 'json'),
    env.KV.list({ prefix: PREFIX }),
  ]);
  return [...new Set([...(index ?? []), ...keys.map((k) => k.name.slice(PREFIX.length))])];
}
async function setIndex(env: Env, edit: (names: Set<string>) => void) {
  const set = new Set((await env.KV.get<string[]>(INDEX, 'json')) ?? []);
  edit(set);
  await env.KV.put(INDEX, JSON.stringify([...set]));
}

export async function listSecrets(env: Env): Promise<SecretInfo[]> {
  const rows = await Promise.all(
    (await names(env)).map(async (name) => {
      const [s, test] = await Promise.all([
        env.KV.get<StoredSecret>(PREFIX + name, 'json'),
        env.KV.get<KeyTest>(TEST + name, 'json'),
      ]);
      return s ? info(name, s, test) : null;
    }),
  );
  return rows.filter((r) => r !== null).sort((a, b) => a.label.localeCompare(b.label));
}

export async function putSecret(
  env: Env,
  name: string,
  input: { label: string; value: string; kind: StoredSecret['kind'] },
  by: string,
): Promise<SecretInfo> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(name) },
    await key(env),
    enc.encode(input.value),
  );
  const stored: StoredSecret = {
    v: 1,
    kind: input.kind,
    label: input.label,
    iv: b64(iv),
    ct: b64(ct),
    last4: input.value.slice(-4),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  await env.KV.put(PREFIX + name, JSON.stringify(stored));
  await setIndex(env, (n) => n.add(name));
  await env.KV.delete(TEST + name);
  return info(name, stored, null);
}

export async function deleteSecret(env: Env, name: string) {
  await Promise.all([env.KV.delete(PREFIX + name), env.KV.delete(TEST + name)]);
  await setIndex(env, (n) => n.delete(name));
}

export async function hasSecret(env: Env, name: string) {
  return (await read(env, name)) !== null;
}

/** The plaintext, for the Worker's own calls only (never returned by the API). */
export async function revealSecret(env: Env, name: string): Promise<string | null> {
  const s = await read(env, name);
  if (!s) return null;
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(s.iv), additionalData: enc.encode(name) },
    await key(env),
    unb64(s.ct),
  );
  return new TextDecoder().decode(pt);
}

/** Checks a Cloudflare API token against the token verify endpoint and keeps the result. */
export async function testSecret(env: Env, name: string): Promise<SecretInfo | null> {
  const s = await read(env, name);
  if (!s) return null;
  let test: KeyTest;
  try {
    const token = await revealSecret(env, name);
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REST_MS),
    });
    const body = (await res.json()) as {
      success?: boolean;
      result?: { status?: string };
      errors?: { message: string }[];
    };
    if (body.success && token) {
      // Which accounts it reaches, and in which listing tag keys works. That needs Tag Read; Write
      // can't be checked without writing, so a token with Read only fails on its first save.
      const listed = await listAccounts(token).then(
        (x) => ({ ok: true as const, x }),
        (e) => ({ ok: false as const, x: [] as { id: string }[], e }),
      );
      const accounts = listed.x;
      const tags = await Promise.all(
        accounts.map((a) =>
          fetch(`https://api.cloudflare.com/client/v4/accounts/${a.id}/tags/keys`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(REST_MS),
          })
            .then((r) => r.ok)
            .catch(() => false),
        ),
      );
      const tagAccounts = tags.filter(Boolean).length;
      test = listed.ok
        ? {
            at: new Date().toISOString(),
            ok: true,
            detail: `Token ${body.result?.status ?? 'valid'} · ${accounts.length} account${accounts.length === 1 ? '' : 's'} · tag access in ${tagAccounts}`,
            accounts: accounts.length,
            tagAccounts,
          }
        : {
            at: new Date().toISOString(),
            ok: true,
            detail: `Token ${body.result?.status ?? 'valid'}; listing its accounts failed: ${listed.e instanceof Error ? listed.e.message : 'error'}`,
          };
    } else
      test = {
        at: new Date().toISOString(),
        ok: false,
        error: body.errors?.[0]?.message ?? `HTTP ${res.status}`,
      };
  } catch (e) {
    test = { at: new Date().toISOString(), ok: false, error: e instanceof Error ? e.message : 'Test failed' };
  }
  await env.KV.put(TEST + name, JSON.stringify(test));
  return info(name, s, test);
}

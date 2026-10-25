/**
 * Secrets the person enters in Settings, kept in KV encrypted with AES-GCM under SETTINGS_KEY.
 * The key name is the additional data, so a ciphertext can't be moved to another name.
 * Plaintext never leaves the Worker: the API lists names, last four characters and test results.
 *
 * KV layout: `secret:<name>` → StoredSecret (JSON).
 */
import type { Env } from './env';

export interface KeyTest {
  at: string;
  ok: boolean;
  detail?: string | null;
  error?: string | null;
}

interface StoredSecret {
  v: 1;
  kind: 'cf_api_token';
  label: string;
  iv: string;
  ct: string;
  last4: string;
  updatedAt: string;
  updatedBy: string;
  test: KeyTest | null;
}

export type SecretInfo = Pick<
  StoredSecret,
  'kind' | 'label' | 'last4' | 'updatedAt' | 'updatedBy' | 'test'
> & {
  name: string;
};

const PREFIX = 'secret:';
const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.SETTINGS_KEY ? unb64(env.SETTINGS_KEY) : new Uint8Array();
  if (raw.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const info = (name: string, s: StoredSecret): SecretInfo => ({
  name,
  kind: s.kind,
  label: s.label,
  last4: s.last4,
  updatedAt: s.updatedAt,
  updatedBy: s.updatedBy,
  test: s.test,
});

async function read(env: Env, name: string) {
  return env.KV.get<StoredSecret>(PREFIX + name, 'json');
}

export async function listSecrets(env: Env): Promise<SecretInfo[]> {
  const { keys } = await env.KV.list({ prefix: PREFIX });
  const rows = await Promise.all(
    keys.map(async (k) => {
      const s = await env.KV.get<StoredSecret>(k.name, 'json');
      return s ? info(k.name.slice(PREFIX.length), s) : null;
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
    test: null,
  };
  await env.KV.put(PREFIX + name, JSON.stringify(stored));
  return info(name, stored);
}

export async function deleteSecret(env: Env, name: string) {
  await env.KV.delete(PREFIX + name);
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
    });
    const body = (await res.json()) as {
      success?: boolean;
      result?: { status?: string };
      errors?: { message: string }[];
    };
    test = body.success
      ? { at: new Date().toISOString(), ok: true, detail: `Token ${body.result?.status ?? 'valid'}` }
      : { at: new Date().toISOString(), ok: false, error: body.errors?.[0]?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    test = { at: new Date().toISOString(), ok: false, error: e instanceof Error ? e.message : 'Test failed' };
  }
  const next = { ...s, test };
  await env.KV.put(PREFIX + name, JSON.stringify(next));
  return info(name, next);
}

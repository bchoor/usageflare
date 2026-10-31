/**
 * Which accounts the Settings tokens reach, and each account's usage, cached in KV so a page load
 * doesn't re-read Cloudflare. A copy past its 10 minutes is still served at once (stale while
 * revalidate): the account list refreshes in the background, and a usage reply says `stale` so the
 * UI reads it again with `?fresh` without anyone waiting. One account per request keeps every call
 * well inside the Worker's subrequest limit.
 *
 * KV: `accounts:v1` → AccountRef[] (10 min), `usage:v2:<account>` → { account, resources } (10 min,
 * kept 7 days for stale-while-revalidate; written at most every 30 min, worker/store.ts),
 * `prefs:v1`, `view:v1:<page>` → the person's settings and saved page layouts (tags: worker/tags.ts).
 * `seen:v1:<account>` → each listed resource's last day in its list (no expiry), to tell deleted ones.
 * `binds:v1:<account>` → each Worker's bindings at its last deploy, so only Workers deployed since are read.
 */
import type { Prefs } from '../shared/catalog';
import { type BindMemo, historyDates, listAccounts, readAccount, type Seen } from './cloudflare';
import type { Env } from './env';
import { listSecrets, revealSecret } from './secrets';
import { getCopy, putCopy, putIfChanged, quietPut } from './store';
import { taggedIds } from './tags';

const TTL_MS = 10 * 60_000;
/**
 * A usage read reaches KV at most this often (worker/store.ts): Free allows 1,000 KV writes a day,
 * and three accounts refreshed every 10 minutes would spend most of them. In between, the newer
 * copy lives in the isolate that read it.
 */
const USAGE_PERSIST_MS = 30 * 60_000;
/** An unchanged list (accounts, tags) is written again this often, so its age stays honest in KV. */
export const SAME_PERSIST_MS = 60 * 60_000;
/** A `?fresh` read this soon after the last one is served that copy: two tabs, a double tap. */
const FRESH_FLOOR_MS = 60_000;
/** How long KV keeps a copy past its 10 minutes, so a page opened after a quiet week still draws at once. */
export const KEEP_S = 7 * 86_400;
/** A remembered resource gone this long is forgotten, unless a tag still points at it. */
const SEEN_DAYS = 90;

export interface AccountRef {
  id: string;
  name: string;
  token: string;
  tokenLabel: string;
}

/** One account's read as cached: the memory of seen resources stays in its own key. */
type Read = Omit<Awaited<ReturnType<typeof readAccount>>, 'seen' | 'binds'>;

/** Runs work after the reply is sent (the request's `waitUntil`). */
export type Defer = (work: Promise<unknown>) => void;

async function cached<T>(
  env: Env,
  key: string,
  fresh: boolean,
  load: () => Promise<T>,
  defer?: Defer,
): Promise<T> {
  const save = async () => {
    const value = await load();
    await putCopy(env, key, value, { maxGap: SAME_PERSIST_MS, expirationTtl: KEEP_S });
    return value;
  };
  const hit = await getCopy<T>(env, key);
  if (!fresh) {
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    if (hit && defer) {
      defer(save().catch((e) => console.error(e)));
      return hit.value;
    }
  }
  // A read that fails (Cloudflare slow or down) serves the last copy rather than an error.
  return save().catch((e) => {
    if (!hit) throw e;
    console.error(e);
    return hit.value;
  });
}

/** Every account any token can read; the first token (by label) that reaches an account reads it. */
export async function accountRefs(env: Env, fresh: boolean, defer?: Defer) {
  return cached(
    env,
    'accounts:v1',
    fresh,
    async () => {
      const accounts: AccountRef[] = [];
      const errors: { token: string; label: string; error: string }[] = [];
      // A tags-only token from before only writes tags; usage is read with the others.
      for (const s of (await listSecrets(env)).filter((x) => x.kind !== 'cf_tags_token')) {
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
    },
    defer,
  );
}

/** `persist: false` (the watchdog's reads) keeps the read out of the KV copy: its writes are the page's. */
export async function accountUsage(
  env: Env,
  accountId: string,
  fresh: boolean,
  defer?: Defer,
  { persist = true }: { persist?: boolean } = {},
) {
  const { accounts } = await accountRefs(env, false, defer);
  const ref = accounts.find((a) => a.id === accountId);
  if (!ref) return null;
  const prefs = await getPrefs(env);
  const key = `usage:v2:${accountId}`;
  // A plan change in Settings must show at once, so it's part of what the cache is checked against.
  const prev = await getCopy<Read>(env, key);
  // `?fresh` right after another read (two tabs, a double tap) takes that read rather than another.
  const hit = !fresh || (prev && Date.now() - prev.at < FRESH_FLOOR_MS) ? prev : null;
  const want = prefs.plans[accountId];
  // An older copy is served as it is, marked stale; only a plan change in Settings waits for a read.
  if (hit && (want ? hit.value.account.plan === want : hit.value.account.planSource !== 'set')) {
    const stale =
      Date.now() - hit.at >= TTL_MS || historyDates(new Date(hit.at)).at(-1) !== historyDates().at(-1);
    return { dates: historyDates(new Date(hit.at)), stale, ...publicUsage(hit.value) };
  }
  const token = await revealSecret(env, ref.token);
  if (!token) throw new Error('Token missing');
  const seenKey = `seen:v1:${accountId}`;
  const bindsKey = `binds:v1:${accountId}`;
  const [seenRaw, tagged, binds] = await Promise.all([
    env.KV.get(seenKey),
    taggedIds(env, accountId),
    env.KV.get<BindMemo>(bindsKey, 'json'),
  ]);
  const seen = seenRaw ? (JSON.parse(seenRaw) as Seen) : null;
  let result: Awaited<ReturnType<typeof readAccount>>;
  try {
    result = await readAccount(token, { ...ref, planOverride: want }, historyDates(), {
      seen: seen ?? {},
      tagged,
      binds: binds ?? {},
    });
  } catch (e) {
    // Cloudflare failed or was too slow: the last copy, marked stale so it's read again later.
    if (!prev) throw e;
    console.error(e);
    return { dates: historyDates(new Date(prev.at)), stale: true, ...publicUsage(prev.value) };
  }
  const { seen: next, binds: nextBinds, ...read } = result;
  // Both change at most once a day (a deploy, a new day's sighting): written only when they do.
  await putIfChanged(env, bindsKey, JSON.stringify(nextBinds), JSON.stringify(binds ?? {}), {
    expirationTtl: KEEP_S,
  });
  const cutoff = new Date(Date.now() - SEEN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const keep = new Set(tagged);
  await putIfChanged(
    env,
    seenKey,
    JSON.stringify(
      Object.fromEntries(Object.entries(next).filter(([id, x]) => x.d >= cutoff || keep.has(id))),
    ),
    seenRaw,
  );
  // Out of analytics budget (or too slow to answer): a stale but whole copy beats a fresh one full of gaps.
  if (read.rateLimited && prev) {
    return { dates: historyDates(new Date(prev.at)), stale: false, ...publicUsage(prev.value) };
  }
  if (persist)
    await putCopy(env, key, read, {
      minGap: USAGE_PERSIST_MS,
      maxGap: USAGE_PERSIST_MS,
      expirationTtl: KEEP_S,
    });
  return { dates: historyDates(), stale: false, ...publicUsage(read) };
}

/** The token's KV name stays in the Worker; the UI only shows its label. */
const publicUsage = (v: Read) => ({
  ...v,
  account: { ...v.account, token: '' },
});

// ---------- The person's settings and layouts ----------

const DEFAULT_PREFS: Prefs = { warn: 75, plans: {} };

export async function getPrefs(env: Env): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...(await env.KV.get<Prefs>('prefs:v1', 'json')) };
}
export const putPrefs = (env: Env, p: Prefs) => env.KV.put('prefs:v1', JSON.stringify(p));

/** Field keys renamed since a layout could have been saved: labels became tags. */
const RENAMED: Record<string, string> = { label: 'tag', labels: 'tags' };
const rename = (k: unknown) => (typeof k === 'string' ? (RENAMED[k] ?? k) : k);
const renameKeys = (o: unknown) =>
  o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [rename(k), v])) : o;

/** Only the places a view config names fields; the person's own words (names, filter values) stay. */
// biome-ignore lint/suspicious/noExplicitAny: a saved view from any version of the app.
function renameFields(v: any): unknown {
  if (!v || typeof v !== 'object') return v;
  const out = { ...v };
  // The account Limits default view's own name, not one the person typed.
  if (out.name === 'By label') out.name = 'By tag';
  for (const k of ['columns', 'hidden']) if (Array.isArray(out[k])) out[k] = out[k].map(rename);
  for (const k of ['formats', 'aggs', 'shows']) if (out[k]) out[k] = renameKeys(out[k]);
  if (out.group)
    out.group = { ...out.group, fields: out.group.fields?.map(rename), default: rename(out.group.default) };
  if ('subgroup' in out) out.subgroup = rename(out.subgroup);
  if (out.sort?.key) out.sort = { ...out.sort, key: rename(out.sort.key) };
  if (Array.isArray(out.chips))
    out.chips = out.chips.map((c: { key?: string }) => ({ ...c, key: rename(c.key) }));
  if (out.filters)
    out.filters = {
      ...out.filters,
      fields: out.filters.fields?.map(rename),
      default: out.filters.default?.map((t: { key?: string }) => ({ ...t, key: rename(t.key) })),
    };
  if (Array.isArray(out.cards)) out.cards = out.cards.map((c: unknown) => renameFields(c));
  if (out.config) out.config = renameFields(out.config);
  return out;
}

/** A page's saved layout, its field keys brought up to date (and saved back when they changed). */
export async function getView(env: Env, page: string, defer: Defer) {
  const raw = await env.KV.get(`view:v1:${page}`);
  if (!raw) return null;
  const view = renameFields(JSON.parse(raw));
  // Saved back after the reply: the fix-up never holds the request.
  if (JSON.stringify(view) !== raw) defer(quietPut(env, `view:v1:${page}`, JSON.stringify(view)));
  return view;
}
export const putView = (env: Env, page: string, config: unknown) =>
  env.KV.put(`view:v1:${page}`, JSON.stringify(config));
export const deleteView = (env: Env, page: string) => env.KV.delete(`view:v1:${page}`);

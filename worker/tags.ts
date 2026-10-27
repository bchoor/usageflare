/**
 * Tags: Cloudflare's own resource tags (its Tagging API) wherever a token with Account › Tag reaches
 * the account, and kept in usageflare for the rest (no such token yet, or a product Cloudflare
 * can't tag). A project
 * tag `newsletter` is the key `project.newsletter` with no value, so a resource holds as many as it
 * likes; any other Cloudflare tag shows as `key=value`. Colours and icons stay here: Cloudflare
 * tags hold text only. Each account keeps its own tags, as Cloudflare does: one name in two
 * accounts is two tags (its own colour in each), and a filter by name still finds both.
 *
 * Cloudflare decides who has a tag. A write reads the resource's tags, changes only the tags the
 * person changed and sends the whole set back with the ETag it read (`If-Match`), so a tag made in
 * the Cloudflare dashboard is never dropped and an edit made there in between fails as 412 instead
 * of being overwritten. A save carries changes (tags to add and to take off per resource), applied
 * to what each resource has now. It does at most `MAX_WRITES` writes and answers how many are
 * `left`; the client sends the same changes again until none are, which keeps each request inside the Worker's
 * subrequest limit.
 *
 * KV: `tags:v2` → { tags (each with its account), local }; `tagaccess:v1` → which tags token reaches which account (10 min);
 * `cftags:v1:<account>` → the account's tagged resources as Cloudflare listed them (5 min). A page
 * load is served an older copy of either at once and Cloudflare is read after the reply; a save
 * always reads it fresh.
 * The copy from before (`tags:v1`, whose tags spanned accounts, or `labels:v1` before it) moves
 * into `tags:v2` once, each tag into every account that uses it, and is kept 30 days as a backup.
 */
import {
  acctOf,
  CF_TAG_TYPE,
  type ProductId,
  type Resource,
  type Tag,
  type TagsState,
  tagFromCf,
  tagToCf,
} from '../shared/catalog';
import { REST_MS } from './cloudflare';
import type { Env } from './env';
import { listSecrets, revealSecret } from './secrets';
import { accountRefs, type Defer, KEEP_S } from './usage';

const API = 'https://api.cloudflare.com/client/v4';
const KEY = 'tags:v2';
const BEFORE = ['tags:v1', 'labels:v1'];
const ACCESS_KEY = 'tagaccess:v1';
const ACCESS_TTL_MS = 10 * 60_000;
const LIST_TTL_MS = 5 * 60_000;
/** Writes per request: a read and a write each (two tries for a Worker), with room for the lists. */
const MAX_WRITES = 10;

interface Stored {
  tags: Tag[];
  /** resource id → tag names Cloudflare doesn't hold for it. */
  local: Record<string, string[]>;
  /** resource id → what Cloudflare said when it refused a write, until a write takes. */
  refused?: Record<string, string>;
}

interface CfTagged {
  type: string;
  id: string;
  name: string;
  tags: Record<string, string>;
  etag?: string;
}

/**
 * For a "Try anyway" on a product Cloudflare's Tagging API lists no type for: the type it would most
 * likely have, so Cloudflare's own answer says whether it takes it.
 */
const TRY_TYPE: Partial<Record<ProductId, string>> = {
  workflows: 'workflow',
  containers: 'container',
  hyperdrive: 'hyperdrive_config',
  ai: 'ai_model',
  builds: 'build',
  basin: 'pipeline',
};

const PRODUCT_BY_TYPE = new Map(Object.entries(CF_TAG_TYPE).map(([p, t]) => [t, p as ProductId]));

class TagError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function cf<T>(token: string, path: string, init?: RequestInit) {
  const res = await fetch(API + path, {
    signal: AbortSignal.timeout(REST_MS),
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    result_info?: { cursor?: string | null };
    errors?: { message: string }[];
  } | null;
  if (!res.ok || !body?.success)
    throw new TagError(body?.errors?.[0]?.message ?? `HTTP ${res.status}`, res.status);
  return { result: body.result as T, cursor: body.result_info?.cursor ?? null };
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const same = (a: string[], b: string[]) => uniq(a).join('\n') === uniq(b).join('\n');
const namesOf = (tags: Record<string, string>) => Object.entries(tags).map(([k, v]) => tagFromCf(k, v));

/** The tags as kept in KV; the first read moves the copy from before into each account. */
export async function getStored(env: Env): Promise<Stored> {
  const hit = await env.KV.get<Stored>(KEY, 'json');
  if (hit) return hit;
  for (const key of BEFORE) {
    const raw = await env.KV.get(key);
    if (!raw) continue;
    const before = JSON.parse(raw) as {
      tags?: Omit<Tag, 'acct'>[];
      labels?: Omit<Tag, 'acct'>[];
      local?: Record<string, string[]>;
      assign?: Record<string, string[]>;
    };
    const local = before.local ?? before.assign ?? {};
    // Who uses a tag: the resources kept here, and the ones Cloudflare listed when last read.
    const used = new Map<string, Set<string>>();
    const use = (acct: string, name: string) => used.set(name, (used.get(name) ?? new Set()).add(acct));
    for (const [id, names] of Object.entries(local)) for (const n of names) use(acctOf(id), n);
    const { accounts } = await accountRefs(env, false).catch(() => ({ accounts: [] as { id: string }[] }));
    await Promise.all(
      accounts.map(async (a) => {
        const hit = await env.KV.get<{ value: CfTagged[] }>(`cftags:v1:${a.id}`, 'json');
        for (const t of hit?.value ?? []) for (const n of namesOf(t.tags)) use(a.id, n);
      }),
    );
    // A tag on no resource has no account to go to; the copy kept below still has it.
    const tags: Tag[] = [];
    for (const t of before.tags ?? before.labels ?? []) {
      const accts = used.get(t.name) ?? new Set<string>();
      for (const acct of accts) tags.push({ ...t, acct });
    }
    const stored: Stored = { tags, local };
    await env.KV.put(KEY, JSON.stringify(stored));
    await env.KV.put(key, raw, { expirationTtl: 30 * 86_400 });
    return stored;
  }
  return { tags: [], local: {} };
}

/** Account id → the tags token (its KV name) that reaches it, or why none does. */
type Access = Record<string, { secret?: string; error?: string }>;

/**
 * A KV copy that's fresh is used as it is; an older one too when the read can be deferred (stale
 * while revalidate), with `load` run after the reply. Otherwise `load` runs now.
 */
async function swr<T>(
  env: Env,
  key: string,
  ttl: number,
  fresh: boolean,
  load: () => Promise<T>,
  defer?: Defer,
) {
  const hit = await env.KV.get<{ at: number; value: T }>(key, 'json');
  if (!fresh) {
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    if (hit && defer) {
      defer(load().catch((e) => console.error(e)));
      return hit.value;
    }
  }
  // A read that fails (Cloudflare slow or down) serves the last copy rather than an error.
  return load().catch((e) => {
    if (!hit) throw e;
    console.error(e);
    return hit.value;
  });
}

const tagAccess = (env: Env, fresh: boolean, defer?: Defer) =>
  swr(env, ACCESS_KEY, ACCESS_TTL_MS, fresh, () => probeTagAccess(env), defer);

async function probeTagAccess(env: Env): Promise<Access> {
  // The usage token writes tags too when it has Account › Tag › Edit; a tags-only token saved
  // before that is tried after it.
  const secrets = (await listSecrets(env)).sort(
    (a, b) => Number(a.kind === 'cf_tags_token') - Number(b.kind === 'cf_tags_token'),
  );
  const out: Access = {};
  if (secrets.length) {
    const { accounts } = await accountRefs(env, false);
    const tokens = await Promise.all(
      secrets.map(async (s) => [s.name, await revealSecret(env, s.name)] as const),
    );
    await Promise.all(
      accounts.map(async (a) => {
        for (const [name, token] of tokens) {
          if (!token) continue;
          try {
            // Listing the keys needs Tag Read; it answers even when nothing is tagged yet.
            await cf(token, `/accounts/${a.id}/tags/keys`);
            out[a.id] = { secret: name };
            return;
          } catch (e) {
            out[a.id] = { error: e instanceof Error ? e.message : 'Refused' };
          }
        }
      }),
    );
  }
  await env.KV.put(ACCESS_KEY, JSON.stringify({ at: Date.now(), value: out }), { expirationTtl: KEEP_S });
  return out;
}

/** Every resource in the account that has a tag, of the types usageflare shows. */
const listTagged = (env: Env, acct: string, token: string, fresh: boolean, defer?: Defer) =>
  swr(env, `cftags:v1:${acct}`, LIST_TTL_MS, fresh, () => readTagged(env, acct, token), defer);

async function readTagged(env: Env, acct: string, token: string): Promise<CfTagged[]> {
  const key = `cftags:v1:${acct}`;
  const out: CfTagged[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const r: { result: CfTagged[]; cursor: string | null } = await cf<CfTagged[]>(
      token,
      `/accounts/${acct}/tags/resources${q}`,
    );
    out.push(...(r.result ?? []).filter((x) => PRODUCT_BY_TYPE.has(x.type)));
    cursor = r.cursor;
    if (!cursor) break;
  }
  await env.KV.put(key, JSON.stringify({ at: Date.now(), value: out }), { expirationTtl: KEEP_S });
  return out;
}

/** The account's resources from its cached usage read, for their Cloudflare ids. */
async function knownResources(env: Env, acct: string): Promise<Resource[]> {
  const hit = await env.KV.get<{ value: { resources: Resource[] } }>(`usage:v2:${acct}`, 'json');
  return hit?.value.resources ?? [];
}

/** Cloudflare's tagged resources keyed by usageflare's resource id. */
async function cfIndex(env: Env, acct: string, token: string, fresh: boolean, defer?: Defer) {
  const [tagged, known] = await Promise.all([
    listTagged(env, acct, token, fresh, defer),
    knownResources(env, acct),
  ]);
  const byCf = new Map<string, string>();
  for (const r of known) {
    const type = CF_TAG_TYPE[r.product];
    if (!type) continue;
    if (r.cfId) byCf.set(`${type}|${r.cfId}`, r.id);
    byCf.set(`${type}|name|${r.name}`, r.id);
  }
  const out = new Map<string, CfTagged>();
  for (const t of tagged) {
    const product = PRODUCT_BY_TYPE.get(t.type) as ProductId;
    const id =
      byCf.get(`${t.type}|${t.id}`) ?? byCf.get(`${t.type}|name|${t.name}`) ?? `${acct}:${product}:${t.name}`;
    out.set(id, t);
  }
  return { out, known: new Map(known.map((r) => [r.id, r])) };
}

/** Tags and who has them: Cloudflare's for accounts with a tags token, plus the ones kept here. */
export async function readTags(
  env: Env,
  fresh: boolean,
  /** Probe which tags token reaches which account again (a save trusts the 10-minute copy). */
  freshAccess = fresh,
  /** Serve older copies at once and read Cloudflare after the reply (page loads, not saves). */
  defer?: Defer,
): Promise<
  TagsState & { cf: Map<string, CfTagged>; known: Map<string, Resource>; raw: Access; readable: Set<string> }
> {
  const [stored, access] = await Promise.all([getStored(env), tagAccess(env, freshAccess, defer)]);
  const assign: Record<string, string[]> = {};
  for (const [id, names] of Object.entries(stored.local)) if (names.length) assign[id] = [...names];
  const cfAll = new Map<string, CfTagged>();
  const known = new Map<string, Resource>();
  const state: TagsState['access'] = {};
  let readAt: string | undefined;
  /** Accounts whose tags were read just now: only those are written. */
  const readable = new Set<string>();
  const tokens = new Map<string, string | null>();
  await Promise.all(
    Object.entries(access).map(async ([acct, a]) => {
      state[acct] = { write: !!a.secret, ...(a.error && !a.secret ? { error: a.error } : {}) };
      if (!a.secret) return;
      if (!tokens.has(a.secret)) tokens.set(a.secret, await revealSecret(env, a.secret));
      const token = tokens.get(a.secret);
      if (!token) return;
      try {
        const idx = await cfIndex(env, acct, token, fresh, defer);
        for (const [id, t] of idx.out) {
          cfAll.set(id, t);
          assign[id] = uniq([...(assign[id] ?? []), ...namesOf(t.tags)]);
        }
        for (const [id, r] of idx.known) known.set(id, r);
        readable.add(acct);
        readAt = new Date().toISOString();
      } catch (e) {
        state[acct] = { write: false, error: e instanceof Error ? e.message : 'Reading tags failed' };
      }
    }),
  );
  // A tag made in the Cloudflare dashboard gets a colour from its name until it's given one here.
  const tags = [...stored.tags];
  const has = new Set(tags.map((t) => `${t.acct}|${t.name}`));
  for (const [id, names] of Object.entries(assign)) {
    const acct = acctOf(id);
    for (const n of names)
      if (!has.has(`${acct}|${n}`)) {
        has.add(`${acct}|${n}`);
        tags.push({ acct, name: n, c: hueOf(n) });
      }
  }
  return {
    tags,
    assign,
    local: stored.local,
    refused: stored.refused ?? {},
    access: state,
    readAt,
    cf: cfAll,
    known,
    raw: access,
    readable,
  };
}

/** A steady palette index from a name, so an uncoloured tag keeps its colour between reads. */
const hueOf = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 10;
};

const publicState = ({
  cf: _cf,
  known: _known,
  raw: _raw,
  readable: _readable,
  ...s
}: Awaited<ReturnType<typeof readTags>>) => s;

export async function getTagsState(env: Env, fresh: boolean, defer?: Defer): Promise<TagsState> {
  return publicState(await readTags(env, fresh, fresh, defer));
}

/** Resource ids that carry a tag in this account, so a deleted one is still remembered. */
export async function taggedIds(env: Env, acct: string): Promise<string[]> {
  const [stored, hit] = await Promise.all([
    getStored(env),
    env.KV.get<{ value: CfTagged[] }>(`cftags:v1:${acct}`, 'json'),
  ]);
  return [
    ...Object.keys(stored.local).filter((id) => id.startsWith(`${acct}:`) && stored.local[id]?.length),
    ...(hit?.value ?? []).map((t) => `${acct}:${PRODUCT_BY_TYPE.get(t.type)}:${t.name}`),
  ];
}

/** What to change on one resource: tag names to add and to take off. */
export type TagChange = { add: string[]; remove: string[] };

const ifMatch = (etag?: string) =>
  etag ? { 'If-Match': etag.startsWith('"') ? etag : `"${etag}"` } : ({} as Record<string, string>);

/**
 * Saves tags: colours and icons here, and each changed resource's tags in Cloudflare where it can
 * hold them, else here. A change is applied to what the resource has now (in Cloudflare and here),
 * never to an older copy the page read, so a tag added or removed in the Cloudflare dashboard in
 * between stays as it is there. With `push`, tags kept here for a resource Cloudflare can hold
 * move there too. `force` tries the resources Cloudflare can't take (no tag type, deleted, or refused
 * before) anyway, and keeps what Cloudflare answers.
 */
export async function saveTags(
  env: Env,
  meta: Tag[],
  changes: Record<string, TagChange>,
  push: boolean,
  force: string[] = [],
): Promise<TagsState> {
  const cur = await readTags(env, true, false);
  const local = { ...cur.local };
  const refused = { ...cur.refused };
  const forced = new Set(force);
  const failed: { id: string; error: string }[] = [];
  const written = new Map<string, CfTagged[]>();
  const todo = { ...changes };
  const writable = (id: string) => {
    const [acct = '', product] = id.split(':') as [string, ProductId];
    return (!!CF_TAG_TYPE[product] || forced.has(id)) && cur.readable.has(acct);
  };
  // Only resources that still exist move: Cloudflare can't tag a deleted one, so it keeps its tags here.
  const live = (id: string) => {
    const r = cur.known.get(id);
    return !!r && r.state !== 'deleted';
  };
  if (push)
    for (const id of Object.keys(local))
      if (writable(id) && live(id) && !refused[id]) todo[id] ??= { add: [], remove: [] };
  for (const id of forced) {
    todo[id] ??= { add: [], remove: [] };
    if (!cur.readable.has(acctOf(id)))
      failed.push({ id, error: "No token that writes tags reaches this resource's account" });
  }
  let writes = 0;
  let left = 0;
  const tokens = new Map<string, string | null>();
  for (const [id, ch] of Object.entries(todo)) {
    const next = uniq([...(cur.assign[id] ?? []).filter((n) => !ch.remove.includes(n)), ...ch.add]);
    const [acct = '', product] = id.split(':') as [string, ProductId];
    const type = CF_TAG_TYPE[product] ?? (forced.has(id) ? (TRY_TYPE[product] ?? product) : undefined);
    const secret = cur.raw[acct]?.secret;
    const keepHere = () => {
      if (next.length) local[id] = next;
      else delete local[id];
    };
    if (!type || !secret || !writable(id)) {
      keepHere();
      continue;
    }
    const item = cur.cf.get(id);
    if (same(next, item ? namesOf(item.tags) : [])) {
      delete local[id];
      continue;
    }
    const r = cur.known.get(id);
    const ids = item
      ? [item.id]
      : uniq(
          [
            r?.cfId ?? '',
            product === 'workers' || forced.has(id) ? (r?.name ?? id.split(':').slice(2).join(':')) : '',
          ].filter(Boolean),
        );
    if (!tokens.has(secret)) tokens.set(secret, await revealSecret(env, secret));
    const token = tokens.get(secret);
    // Cloudflare's id isn't known until the account is read again: keep the tags here meanwhile.
    if (!token || !ids.length) {
      keepHere();
      continue;
    }
    if (writes >= MAX_WRITES) {
      left++;
      continue;
    }
    writes++;
    let error = '';
    for (const rid of ids) {
      try {
        // Not in the list: read its tags first, so the write keeps any it has (500 = none yet).
        let base = item ? { tags: item.tags, etag: item.etag } : null;
        if (!base) {
          const q = new URLSearchParams({ resource_type: type, resource_id: rid });
          base = await cf<{ tags?: Record<string, string>; etag?: string }>(
            token,
            `/accounts/${acct}/tags?${q}`,
          )
            .then((x) => ({ tags: x.result.tags ?? {}, etag: x.result.etag }))
            .catch(() => ({ tags: {}, etag: undefined }));
        }
        const tags = { ...base.tags };
        for (const n of namesOf(base.tags)) if (!next.includes(n)) delete tags[tagToCf(n)[0]];
        for (const n of next) {
          const [k, v] = tagToCf(n);
          tags[k] = v;
        }
        const out = await cf<Partial<CfTagged>>(token, `/accounts/${acct}/tags`, {
          method: 'PUT',
          body: JSON.stringify({ resource_type: type, resource_id: rid, tags }),
          headers: ifMatch(base.etag),
        });
        const list = written.get(acct) ?? [];
        list.push({
          type,
          id: out.result.id ?? rid,
          name: out.result.name ?? r?.name ?? item?.name ?? rid,
          tags: out.result.tags ?? tags,
          etag: out.result.etag,
        });
        written.set(acct, list);
        error = '';
        break;
      } catch (e) {
        const changed = e instanceof TagError && e.status === 412;
        error = changed
          ? 'Changed in Cloudflare since it was read: showing its tags now'
          : e instanceof Error
            ? e.message
            : 'Write failed';
        if (changed) break;
      }
    }
    if (!error) {
      delete local[id];
      delete refused[id];
    } else {
      failed.push({ id, error });
      // A changed resource (412) is read again; anything else is Cloudflare saying no.
      if (!error.startsWith('Changed in Cloudflare')) refused[id] = error;
    }
  }
  await env.KV.put(KEY, JSON.stringify({ tags: meta, local, refused } satisfies Stored));
  // The written resources go into each account's cached list, so the answer needs no second read.
  await Promise.all(
    [...written].map(async ([acct, items]) => {
      const key = `cftags:v1:${acct}`;
      const hit = await env.KV.get<{ at: number; value: CfTagged[] }>(key, 'json');
      const keyOf = (t: CfTagged) => `${t.type}|${t.id}`;
      const fresh = new Map(items.map((t) => [keyOf(t), t]));
      const value = [...(hit?.value ?? []).filter((t) => !fresh.has(keyOf(t))), ...items].filter(
        (t) => Object.keys(t.tags).length,
      );
      await env.KV.put(key, JSON.stringify({ at: hit?.at ?? Date.now(), value }), { expirationTtl: KEEP_S });
    }),
  );
  return { ...(await getTagsState(env, false)), failed, left };
}

/** Forget which tags token reaches which account (a token was added, replaced or deleted). */
export const forgetTagAccess = (env: Env) => env.KV.delete(ACCESS_KEY);

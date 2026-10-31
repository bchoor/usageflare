/**
 * What the pages read: the accounts and their usage from the Worker, judged against plan allowances
 * (used, forecast, cost, status per account and metric), plus tags and prefs. Every page shares
 * these hooks, so one fetch serves them all.
 */
import {
  apiJson,
  KIT,
  type LumenLoad,
  type TrendChange,
  trendChange,
  useLumenLoad,
} from '@columenlabs/lumen-ui';
import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import {
  acctOf,
  type Billed,
  CF_TAG_TYPE,
  METRICS,
  PRODUCT,
  type Prefs,
  type ProductId,
  type Resource,
  type TagsDoc,
  type TagsState,
} from '../shared/catalog';
import {
  type AccountView,
  billed,
  inferPlan,
  judge,
  monthAvg,
  STATUS_LABEL,
  type Status,
  type Usage,
  type UsageRead,
} from '../shared/judge';

export { type AccountView, billed, SEVERITY, STATUS_LABEL, type Status, type Usage } from '../shared/judge';

export interface AccountRef {
  id: string;
  name: string;
  tokenLabel: string;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Reloads skip the Worker's cache once (the header's Refresh). */
let freshOnce = false;
export const skipCacheOnce = () => {
  freshOnce = true;
};
const q = () => (freshOnce ? '?fresh' : '');

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () =>
      apiJson<{ accounts: AccountRef[]; errors: { label: string; error: string }[] }>(
        `/api/accounts${q()}`,
        undefined,
        'accounts',
      ),
  });
}

interface AccountUsage extends UsageRead {
  /** The Worker's copy is past its 10 minutes: shown now, read again in the background. */
  stale?: boolean;
}

/** Accounts whose stale copy is being read again in the background. */
const refreshing = new Set<string>();
const listeners = new Set<() => void>();
const ping = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True while a stale copy is being swapped for a fresh one (the status bar's "refreshing…"). */
export const useRefreshing = () => useSyncExternalStore(subscribe, () => refreshing.size > 0);

/**
 * One account's usage. A stale copy comes back at once so the page draws it, and a `?fresh` read
 * runs behind it and swaps the new numbers in quietly when it lands.
 */
async function readUsage(qc: QueryClient, id: string) {
  // A read that has to go to Cloudflare can take longer than the kit's 15 s for reads.
  const d = await apiJson<AccountUsage>(`/api/accounts/${id}/usage${q()}`, { timeoutMs: 30_000 }, 'usage');
  if (d.stale && !refreshing.has(id)) {
    refreshing.add(id);
    ping();
    apiJson<AccountUsage>(`/api/accounts/${id}/usage?fresh`, { timeoutMs: 30_000 }, 'usage')
      .then((f) => qc.setQueryData(['usage', id], f))
      .catch(() => {})
      .finally(() => {
        refreshing.delete(id);
        ping();
      });
  }
  return d;
}

export function usePrefs() {
  return useQuery({ queryKey: ['prefs'], queryFn: () => apiJson<Prefs>('/api/prefs', undefined, 'prefs') });
}

export function useSavePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Prefs) => apiJson<Prefs>('/api/prefs', json('PUT', p), 'prefs.put'),
    onSuccess: (p) => {
      qc.setQueryData(['prefs'], p);
      return qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });
}

const EMPTY_TAGS: TagsState = { tags: [], assign: {}, local: {}, access: {} };

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => apiJson<TagsState>('/api/tags', undefined, 'tags'),
    staleTime: 60_000,
  });
}

/**
 * Saves tags. Cloudflare takes a few writes per request, so the same doc goes again while the
 * Worker says writes are `left` (and each round made progress); `push` also moves tags kept here
 * to Cloudflare where it can hold them.
 */
/** Per resource, the tag names `to` adds to `from` and the ones it takes off. */
export function tagChanges(from: Record<string, string[]>, to: Record<string, string[]>) {
  const out: Record<string, { add: string[]; remove: string[] }> = {};
  for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = new Set(from[id] ?? []);
    const b = new Set(to[id] ?? []);
    const add = [...b].filter((n) => !a.has(n));
    const remove = [...a].filter((n) => !b.has(n));
    if (add.length || remove.length) out[id] = { add, remove };
  }
  return out;
}

/**
 * Saves tags: the changes from `base` (what the page showed) to `doc`, so a tag edited in the
 * Cloudflare dashboard meanwhile is left as it is. Cloudflare takes a few writes per request: the
 * changes go again, less any that failed, while the Worker says writes are `left` and fewer are
 * left each time. `push` also moves tags kept here to Cloudflare where it can hold them.
 */
export function useSaveTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      doc,
      base,
      push,
      force,
    }: {
      doc: TagsDoc;
      base: TagsDoc;
      push?: boolean;
      force?: string[];
    }) => {
      const changes = tagChanges(base.assign, doc.assign);
      const put = () =>
        apiJson<TagsState>('/api/tags', json('PUT', { tags: doc.tags, changes, push, force }), 'tags.put');
      let out = await put();
      const failed = new Map((out.failed ?? []).map((f) => [f.id, f]));
      for (let i = 0; i < 25 && out.left; i++) {
        const before = out.left;
        for (const id of failed.keys()) delete changes[id];
        out = await put();
        for (const f of out.failed ?? []) failed.set(f.id, f);
        if ((out.left ?? 0) >= before) break;
      }
      return { ...out, failed: [...failed.values()] };
    },
    onMutate: ({ doc }) =>
      qc.setQueryData<TagsState>(['tags'], (cur) => ({
        ...(cur ?? EMPTY_TAGS),
        tags: doc.tags,
        assign: doc.assign,
      })),
    onSuccess: (state) => qc.setQueryData(['tags'], state),
    onError: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });
}

// ---------- Judging usage against the plan (shared/judge.ts) ----------

export const ACCOUNT_COLORS = [
  'var(--chart-1)',
  'var(--chart-6)',
  'var(--chart-5)',
  'var(--chart-3)',
  'var(--chart-9)',
  'var(--chart-4)',
];

/**
 * A resource's part of a meter's bill. Stored sizes split by the resource's own GB-months, so a
 * bucket filled last week pays for last week, not the whole month; the rest by this period's use.
 */
export function partShare(u: Usage, r: Resource, v: number): number {
  if (u.m.kind !== 'gauge') return u.used ? v / u.used : 0;
  return u.forecast ? monthAvg(r.series[u.m.key] ?? [], u.a) / u.forecast : 0;
}

/**
 * A meter's estimated charge over the month's first `k` days, worked out the way `judge` works out
 * `cost`, so it lines up with a bill that runs `k` days.
 */
function costTo(u: Usage, k: number): number {
  if (u.hard || k <= 0) return 0;
  const n = u.days.length;
  const days = u.days.slice(Math.max(0, n - u.a.day), Math.max(0, n - u.a.day) + k);
  const over = (x: number) => billed(u.m, Math.max(0, x - u.limit));
  if (u.m.kind === 'gauge') {
    const sofar = days.reduce((x, y) => x + y, 0) / u.a.monthDays;
    return billed(u.m, Math.max(0, sofar - (u.limit * days.length) / u.a.monthDays)) * u.price;
  }
  if (u.per === 'day') return days.reduce((s, v) => s + over(v), 0) * u.price;
  return over(days.reduce((x, y) => x + y, 0)) * u.price;
}

/** Billed usage beside our estimate for the same days, per product and in all. */
export interface BillCheck {
  billed: number;
  /** Our estimate over the days billed; null when the billing period isn't the calendar month. */
  est: number | null;
  /** Billed (for the products we track) and estimated differ by more than 10% and 50¢. */
  gap: boolean;
  from: string;
  through: string | null;
  lines: { key: string; label: string; product: ProductId | null; billed: number; est: number | null }[];
}

const gapOf = (billed: number, est: number) => Math.abs(billed - est) > Math.max(0.5, 0.1 * billed);

/**
 * What Cloudflare billed an account (its usage charges, never the base fee) against what we
 * estimate for the same days. `keep` narrows it to some products, as a filtered card does.
 */
export function billCheck(
  usage: Usage[],
  a: AccountView,
  keep: (p: ProductId | null) => boolean = () => true,
): BillCheck | null {
  const b: Billed | undefined = typeof a.billing === 'object' ? a.billing : undefined;
  if (!b) return null;
  const now = new Date();
  const month = now.toISOString().slice(0, 8);
  // Our estimates run over the calendar month, so they compare only when the bill does too.
  const k = b.from === `${month}01` ? (b.through?.startsWith(month) ? Number(b.through.slice(8)) : 0) : null;
  const est = new Map<ProductId, number>();
  for (const u of usage) {
    if (u.a.id !== a.id || !keep(u.m.product)) continue;
    est.set(u.m.product, (est.get(u.m.product) ?? 0) + (k === null ? 0 : costTo(u, k)));
  }
  const lines = new Map<string, BillCheck['lines'][number]>();
  for (const l of b.lines) {
    if (!keep(l.product)) continue;
    const key = l.product ?? l.service;
    const line = lines.get(key) ?? {
      key,
      label: l.product ? PRODUCT[l.product].label : l.service,
      product: l.product,
      billed: 0,
      est: l.product && k !== null ? (est.get(l.product) ?? 0) : null,
    };
    line.billed += l.cost;
    lines.set(key, line);
  }
  // A product we estimate a charge for that Cloudflare hasn't billed.
  for (const [p, v] of est) {
    if (v >= 0.005 && !lines.has(p))
      lines.set(p, { key: p, label: PRODUCT[p].label, product: p, billed: 0, est: v });
  }
  const all = [...lines.values()];
  const billed = all.reduce((s, l) => s + l.billed, 0);
  const total = k === null ? null : [...est.values()].reduce((s, v) => s + v, 0);
  // Services we don't track (Images, Stream) have no estimate, so they stay out of the gap.
  const tracked = all.reduce((s, l) => s + (l.est === null ? 0 : l.billed), 0);
  return {
    billed,
    est: total,
    gap: total !== null && gapOf(tracked, total),
    from: b.from,
    through: b.through,
    lines: [...lines.values()].sort((p, q) => q.billed - p.billed || (q.est ?? 0) - (p.est ?? 0)),
  };
}

/** One product line's gap, for its row in the billed card. */
export const lineGap = (l: BillCheck['lines'][number]) => l.est !== null && gapOf(l.billed, l.est);

/** A resource's numbers: its main metric's share of the allowance, and its share of the bill. */
export interface ResourceInfo {
  /** The meter closest to its own cap ("Watch for"). */
  main: { key: string; u: Usage; v: number; share: number } | null;
  cost: number;
  fcost: number;
  /** Share of the account's allotment: every meter priced at list rates, summed, over the list
   *  value of the whole allotment. One formula for every product, so any two rows compare. */
  plan: number;
  /**
   * The last 7 days' use against the 7 before, priced the same way (0.12 = +12%); null where the
   * week before is too small to divide by (`change` then holds the plain difference).
   */
  trend: number | null;
  /** The same change as Trend 7d draws it: a %, `>10×`, or the main meter's plain difference. */
  change: TrendChange;
}

export interface PlanInfo {
  /** Share of the allotment used, at list prices (the Resources Usage summed over the account). */
  share: number;
  /** The meter closest to its own cap. */
  watch: Usage | null;
  /** Last 7 days against the 7 before, priced (0.12 = +12%). */
  trend: number | null;
  change: TrendChange;
  /** Usage this month so far, day by day (the `dates` before the 1st are null). */
  days: (number | null)[];
}

/** Under this much use of the main meter in the week before (counts, its own unit), Trend 7d shows
 *  the plain difference, never a %. */
const TREND_MIN_BASE = 100;

/** A meter's list price: the plan's own, else the paid plan's (a free plan prices nothing). */
const listPrice = (u: Usage) => u.price || u.m.paid?.[2] || 0;
/** What a meter's monthly allowance is worth at list price; nothing for pay-as-you-go. */
const worthOf = (u: Usage) =>
  u.payg ? 0 : (u.per === 'day' ? u.limit * u.a.monthDays : u.limit) * listPrice(u);

export interface Model {
  /** The pages' loading state for LumenLayout's cards. */
  load: LumenLoad;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  dates: string[];
  accounts: AccountView[];
  account: Record<string, AccountView>;
  resources: Resource[];
  resource: Record<string, Resource>;
  usage: Usage[];
  info: (r: Resource) => ResourceInfo;
  /** Deleted with no usage this billing period: hidden unless the filter asks for deleted ones. */
  archived: (r: Resource) => boolean;
  /** An account's Usage, Watch for and trend, over all its meters or those `keep` passes. */
  plan: (a: AccountView, keep?: (u: Usage) => boolean) => PlanInfo;
  tags: TagsState;
  /** A resource's tags; one Cloudflare can't tag, with none of its own, shows those of the Workers that bind it. */
  tagsOf: (r: Resource) => string[];
  /** Tags shown on `r` only because a Worker that binds it has them. */
  inherited: (r: Resource) => string[];
  prefs: Prefs;
  errors: { label: string; error: string }[];
  /** No token yet: the pages point to Settings. */
  empty: boolean;
}

export function useModel(): Model {
  const accounts = useAccounts();
  const prefs = usePrefs();
  const tagsQ = useTags();
  const qc = useQueryClient();
  const refs = accounts.data?.accounts ?? [];
  const usages = useQueries({
    queries: refs.map((ref) => ({
      queryKey: ['usage', ref.id],
      queryFn: () => readUsage(qc, ref.id),
      staleTime: 5 * 60_000,
    })),
  });
  if (usages.length && usages.every((u) => !u.isFetching)) freshOnce = false;
  const stamp = usages
    .map((u) => `${u.dataUpdatedAt}:${u.status}:${u.fetchStatus}:${u.errorUpdatedAt}`)
    .join(',');
  const load = useLumenLoad(accounts, ...usages);
  const warn = prefs.data?.warn ?? 75;
  // "Watch at" is this app's own watch level: every kit meter (bars, tinted numbers) reads it.
  // Set on KIT directly, not configureLumen, which would re-read preferences mid-render.
  if (KIT.meterLevels.watch !== warn / 100) KIT.meterLevels = { ...KIT.meterLevels, watch: warn / 100 };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` tracks every usage query's data.
  return useMemo(() => {
    const now = new Date();
    const day = now.getUTCDate();
    const monthDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const loaded = usages.map((u) => u.data).filter((d): d is AccountUsage => !!d);
    const views: AccountView[] = refs.flatMap((ref, i) => {
      const d = loaded.find((x) => x.account.id === ref.id);
      return d
        ? [{ ...inferPlan(d), color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] as string, day, monthDays }]
        : [];
    });
    const resources = loaded.flatMap((d) => d.resources);
    const usage: Usage[] = [];
    for (const a of views) {
      const rs = resources.filter((r) => r.acct === a.id);
      for (const m of METRICS) {
        const u = judge(a, m, rs, warn);
        if (u) usage.push(u);
      }
    }
    const worth = new Map<string, number>();
    for (const u of usage) worth.set(u.a.id, (worth.get(u.a.id) ?? 0) + worthOf(u));
    const infoCache = new Map<string, ResourceInfo>();
    const info = (r: Resource): ResourceInfo => {
      const hit = infoCache.get(r.id);
      if (hit) return hit;
      let cost = 0;
      let fcost = 0;
      let main: ResourceInfo['main'] = null;
      let plan = 0;
      let now = 0;
      let prev = 0;
      const all = worth.get(r.acct) || 1;
      for (const key of Object.keys(r.series)) {
        const u = usage.find((x) => x.a.id === r.acct && x.m.key === key);
        const v = u?.parts.find((p) => p.r.id === r.id)?.v;
        if (!u || v === undefined) continue;
        const sh = partShare(u, r, v);
        cost += u.cost * sh;
        fcost += u.fcost * sh;
        const share = shareOf(u, v);
        if (!main || share > main.share) main = { key, u, v, share };
        const p = listPrice(u);
        plan += (u.payg ? v * p : share * worthOf(u)) / all;
        const s = r.series[key] ?? [];
        now += s.slice(-7).reduce((a, b) => a + b, 0) * p;
        prev += s.slice(-14, -7).reduce((a, b) => a + b, 0) * p;
      }
      // A week before with almost no use of the main meter (3 operations) makes any % meaningless:
      // the plain difference in that meter's own unit instead.
      const ms = main && main.u.m.kind !== 'gauge' ? (r.series[main.key] ?? []) : null;
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const change = ms
        ? sum(ms.slice(-14, -7)) <= TREND_MIN_BASE
          ? trendChange(sum(ms.slice(-7)), sum(ms.slice(-14, -7)), { minBase: TREND_MIN_BASE })
          : trendChange(now, prev)
        : trendChange(now, prev);
      const trend =
        change.kind === 'pct' || change.kind === 'many' ? (prev > 0 ? now / prev - 1 : null) : null;
      const out = { main, cost, fcost, plan, trend, change };
      infoCache.set(r.id, out);
      return out;
    };
    // Tags list A to Z everywhere (pickers, sidebar, search), whatever order they were made in.
    const raw = tagsQ.data ?? EMPTY_TAGS;
    const doc: TagsState = {
      ...raw,
      tags: [...raw.tags].sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.acct.localeCompare(b.acct),
      ),
    };
    const known = new Set(doc.tags.map((l) => tagKey(l.acct, l.name)));
    const own = (id: string) => (doc.assign[id] ?? []).filter((n) => known.has(tagKey(acctOf(id), n)));
    const fromWorkers = new Map<string, Set<string>>();
    for (const w of resources)
      for (const id of w.binds ?? []) {
        const product = id.split(':')[1] as Resource['product'];
        if (CF_TAG_TYPE[product] || !own(w.id).length) continue;
        const set = fromWorkers.get(id) ?? new Set<string>();
        for (const n of own(w.id)) set.add(n);
        fromWorkers.set(id, set);
      }
    const inherited = (r: Resource) => (own(r.id).length ? [] : [...(fromWorkers.get(r.id) ?? [])].sort());
    return {
      load,
      loading: accounts.isPending || usages.some((u) => u.isPending),
      fetching: accounts.isFetching || usages.some((u) => u.isFetching),
      error: accounts.error ?? usages.find((u) => u.error)?.error ?? null,
      dates: loaded[0]?.dates ?? [],
      accounts: views,
      account: Object.fromEntries(views.map((a) => [a.id, a])),
      resources,
      resource: Object.fromEntries(resources.map((r) => [r.id, r])),
      usage,
      info,
      archived: (r) => {
        if (r.state !== 'deleted') return false;
        const dates = loaded[0]?.dates ?? [];
        const first = Math.max(
          0,
          dates.findIndex((d) => d.endsWith('-01')),
        );
        return !Object.values(r.series).some((s) => s.slice(first).some((v) => v > 0));
      },
      plan: (a, keep = () => true) => {
        const us = usage.filter((u) => u.a.id === a.id && keep(u));
        const all = worth.get(a.id) || 1;
        let share = 0;
        let now = 0;
        let prev = 0;
        let watch: Usage | null = null;
        for (const u of us) {
          const p = listPrice(u);
          share += (u.payg ? u.used * p : u.pct * worthOf(u)) / all;
          now += u.days.slice(-7).reduce((q, y) => q + y, 0) * p;
          prev += u.days.slice(-14, -7).reduce((q, y) => q + y, 0) * p;
          if (!u.payg && (!watch || u.pct > watch.pct)) watch = u;
        }
        // Month to date per day: counts summed from the 1st, sizes at that day's level.
        const dates = loaded[0]?.dates ?? [];
        const first = dates.findIndex((d) => d.endsWith('-01'));
        const days = dates.map((_, i) => {
          if (first < 0 || i < first) return null;
          let v = 0;
          for (const u of us) {
            const p = listPrice(u);
            const n = u.days.length - dates.length + i;
            v +=
              u.m.kind === 'gauge'
                ? (u.days[n] ?? 0) * p
                : u.days
                    .slice(Math.max(0, u.days.length - dates.length + first), n + 1)
                    .reduce((q, y) => q + y, 0) * p;
          }
          return v / all;
        });
        return {
          share,
          watch,
          trend: prev > 0 ? now / prev - 1 : null,
          change: trendChange(now, prev),
          days,
        };
      },
      tags: doc,
      tagsOf: (r) => {
        const mine = own(r.id);
        return mine.length ? mine : inherited(r);
      },
      inherited,
      prefs: prefs.data ?? { warn: 75, plans: {} },
      errors: accounts.data?.errors ?? [],
      empty: accounts.isSuccess && refs.length === 0,
    };
  }, [
    accounts.data,
    accounts.isPending,
    accounts.isFetching,
    accounts.error,
    stamp,
    tagsQ.data,
    prefs.data,
    warn,
  ]);
}

// ---------- Formatting ----------

/** The unit a storage amount in GB reads best in: 2.4 MB, never 0.00 GB. */
export const gbUnit = (v: number): [string, number] =>
  v >= 1 || v === 0 ? ['GB', 1] : v >= 1e-3 ? ['MB', 1e-3] : v >= 1e-6 ? ['KB', 1e-6] : ['B', 1e-9];

export function fmt(v: number, unit = ''): string {
  if (unit === 'GB') {
    const [u, f] = gbUnit(Math.abs(v));
    const x = v / f;
    const a = Math.abs(x);
    return `${a === 0 ? '0' : a < 10 ? +x.toFixed(2) : a < 100 ? +x.toFixed(1) : Math.round(x)} ${u}`;
  }
  if (unit === 'min') return `${Math.round(v).toLocaleString('en-US')} min`;
  // Under an hour reads in minutes (10 min a day free), never 0.2 h.
  if (unit === 'h' && Math.abs(v) < 1) return `${Math.round(v * 60)} min`;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e9) s = `${(v / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  else if (a >= 1e6) s = `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  else if (a >= 1e4) s = `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  else s = a > 0 && a < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
  return unit ? `${s} ${unit}` : s;
}
/** `v` as a share of `u`'s allowance; 0 where there is none (pay as you go). */
export const shareOf = (u: Usage, v: number) => (u.limit > 0 ? v / u.limit : 0);
/** A share; ten times the allowance and up reads as a multiple (18×), not a four-digit %. */
export const pctText = (p: number) => (p >= 10 ? `${Math.round(p)}×` : `${Math.round(p * 100)}%`);
/** `pctText` split for `UnitValue`: the number and its unit, `%` or `×`. */
export const pctParts = (p: number): [string, string] =>
  p >= 10 ? [String(Math.round(p)), '×'] : [String(Math.round(p * 100)), '%'];
export const usd = (v: number) => `$${v.toFixed(2)}`;
const priceText = (u: Usage) =>
  u.price < 0.001
    ? `$${(u.price * 1e6).toFixed(2)}/M`
    : `$${u.price}/${u.m.unit || 'unit'}${u.m.kind === 'gauge' ? '-month' : ''}`;
/** How a meter's forecast cost is worked out, for its tooltip. */
export function costNote(u: Usage): string {
  if (u.hard) return 'Free plan: a hard limit, never billed';
  const raw = Math.max(0, u.forecast - u.limit);
  const over = billed(u.m, raw);
  if (u.per === 'day') return `Each day's use past ${fmt(u.limit, u.m.unit)} × ${priceText(u)}, to month end`;
  const what =
    u.m.kind === 'gauge'
      ? `average ${fmt(u.forecast, u.m.unit)} this month`
      : `${fmt(u.forecast, u.m.unit)} by month end`;
  return `(${what} − ${fmt(u.limit, u.m.unit)} included) = ${fmt(raw, u.m.unit)}${over > raw ? `, billed as ${fmt(over, u.m.unit)}` : ''} × ${priceText(u)} = ${usd(u.fcost)} for the account`;
}
/** How one resource's part of a meter's forecast cost is worked out, e.g.
 *  "avg 53 GB-mo × $0.015 − 1.3 GB-mo free share = $0.77 (now 184 GB)". */
export function partNote(u: Usage, r: Resource, v: number): string {
  if (u.hard) return 'Free plan: a hard limit, never billed';
  const sh = partShare(u, r, v);
  const cost = usd(u.fcost * sh);
  // A day's cap, or an overage billed in whole units, is the account's: a part takes its share.
  if (u.per === 'day' || u.m.block) return `${Math.round(sh * 100)}% of the account's ${costNote(u)}`;
  const own = u.forecast * sh;
  const free = `${fmt(u.limit * sh, u.m.unit)}${u.m.kind === 'gauge' ? '-mo' : ''} free share`;
  return u.m.kind === 'gauge'
    ? `avg ${fmt(own, u.m.unit)}-mo × ${priceText(u)} − ${free} = ${cost} (now ${fmt(v, u.m.unit)})`
    : `${fmt(own, u.m.unit)} by month end × ${priceText(u)} − ${free} = ${cost}`;
}
export const perText = (u: Usage) => (u.per === 'day' ? '/day' : u.m.kind === 'gauge' ? '' : '/mo');
/** A status's dot, in the kit's meter colours (`--meter-*`), so a status and a bar agree. */
export const sevColor = (st: Status) =>
  st === 'block' || st === 'over'
    ? 'var(--meter-over)'
    : st === 'soon'
      ? 'var(--meter-alert)'
      : st === 'watch'
        ? 'var(--meter-watch)'
        : 'var(--meter-ok)';
/** A status's text on its own tint, darker than the dot so it reads at 4.5:1. */
export const sevText = (st: Status) =>
  `color-mix(in oklab, ${
    st === 'block' || st === 'over'
      ? 'var(--loss)'
      : st === 'soon'
        ? 'var(--caution)'
        : st === 'watch'
          ? 'var(--warning)'
          : 'var(--gain)'
  } 85%, var(--foreground))`;
export const productOf = (r: Resource) => PRODUCT[r.product];

/** `Hit limit Oct 19`, `Exceeds ~Oct 28`, or the status name. */
export function statusText(u: Usage, dates: string[]): string {
  if (u.st === 'block') {
    if (u.pct >= 1) return 'Blocked';
    const d = dates[Number(u.peakDay)];
    return d ? `Hit limit ${dayLabel(d)}` : 'Hit limit';
  }
  if (u.st === 'soon' && u.basis === 'mtd' && u.used > 0) {
    const d = Math.ceil(u.limit / (u.used / u.a.day));
    if (d <= u.a.monthDays) {
      const now = new Date();
      return `Exceeds ~${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    }
  }
  return STATUS_LABEL[u.st];
}

export const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/**
 * A UTC period beside Used, on Cloudflare's usage days: `0` today, `1` yesterday, `'mo'` this
 * calendar month so far.
 */
export type UtcDay = 0 | 1 | 'mo';

export const UTC_DAYS = [0, 1, 'mo'] as const;

export const UTC_DAY_LABEL: Record<UtcDay, string> = { 0: 'Today', 1: 'Yesterday', mo: 'This month' };

/** `YYYY-MM-DD` of a UTC day. */
export const utcDate = (back: 0 | 1) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

/**
 * A daily series' value on a UTC day, by date (a series ends on the day it was read, so a copy read
 * yesterday has no today). This month sums the days from the 1st; a size (`gauge`) reads its latest
 * level instead. Null when the series doesn't reach that day or month.
 */
export function onUtcDay(
  values: number[] | undefined,
  dates: string[],
  back: UtcDay,
  gauge = false,
): number | null {
  if (!values) return null;
  const at = (i: number) => values[values.length - dates.length + i];
  if (back !== 'mo') {
    const i = dates.lastIndexOf(utcDate(back));
    return i < 0 ? null : (at(i) ?? null);
  }
  const month = utcDate(0).slice(0, 7);
  const days = dates.flatMap((d, i) => (d.startsWith(month) ? [at(i)] : []));
  const seen = days.filter((v): v is number => v !== undefined);
  if (!seen.length) return null;
  return gauge ? (seen.at(-1) ?? null) : seen.reduce((t, v) => t + v, 0);
}

/** The end of the billing month, e.g. `Oct 31`. */
export function monthEnd(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const TAG_COLORS = [
  'var(--chart-1)',
  'var(--chart-4)',
  'var(--chart-6)',
  'var(--chart-9)',
  'var(--chart-5)',
  'var(--chart-8)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-10)',
  'var(--chart-7)',
];
/** The tag `name` in `acct`; with no account (a list across accounts), the first account's. */
export const findTag = (doc: TagsDoc, name: string, acct?: string) =>
  (acct && doc.tags.find((l) => l.name === name && l.acct === acct)) || doc.tags.find((l) => l.name === name);
export const tagColor = (doc: TagsDoc, name: string, acct?: string) =>
  TAG_COLORS[(findTag(doc, name, acct)?.c ?? 0) % TAG_COLORS.length] as string;
/** Tag names, each once and A to Z: a name in several accounts filters them all together. */
export const tagNames = (doc: TagsDoc, accts?: string[]) =>
  [...new Set(doc.tags.filter((l) => !accts || accts.includes(l.acct)).map((l) => l.name))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
/** A tag's key in tables and selections: one name in two accounts is two tags. */
export const tagKey = (acct: string, name: string) => `${acct}|${name}`;

/** `Billing Prod` → `billing-prod`: a tag's name. */
export const tagSlug = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32);

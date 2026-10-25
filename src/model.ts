/**
 * What the pages read: the accounts and their usage from the Worker, judged against plan allowances
 * (used, forecast, cost, status per account and metric), plus labels and prefs. Every page shares
 * these hooks, so one fetch serves them all.
 */
import { apiJson, KIT, type LumenLoad, useLumenLoad } from '@columenlabs/lumen-ui';
import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import {
  type Account,
  type LabelsDoc,
  METRICS,
  type Metric,
  PRODUCT,
  type Prefs,
  type Resource,
} from '../shared/catalog';

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

interface AccountUsage {
  dates: string[];
  account: Account;
  resources: Resource[];
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
  const d = await apiJson<AccountUsage>(`/api/accounts/${id}/usage${q()}`, undefined, 'usage');
  if (d.stale && !refreshing.has(id)) {
    refreshing.add(id);
    ping();
    apiJson<AccountUsage>(`/api/accounts/${id}/usage?fresh`, undefined, 'usage')
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

export function useLabels() {
  return useQuery({
    queryKey: ['labels'],
    queryFn: () => apiJson<LabelsDoc>('/api/labels', undefined, 'labels'),
  });
}

export function useSaveLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: LabelsDoc) => apiJson<LabelsDoc>('/api/labels', json('PUT', doc), 'labels.put'),
    onMutate: (doc) => qc.setQueryData(['labels'], doc),
    onSuccess: (doc) => qc.setQueryData(['labels'], doc),
    onError: () => qc.invalidateQueries({ queryKey: ['labels'] }),
  });
}

// ---------- Judging usage against the plan ----------

export type Status = 'block' | 'over' | 'soon' | 'watch' | 'ok';
export const SEVERITY: Record<Status, number> = { block: 4, over: 3, soon: 2, watch: 1, ok: 0 };
export const STATUS_LABEL: Record<Status, string> = {
  block: 'Blocked',
  over: 'Over, billed',
  soon: 'Will exceed',
  watch: 'Watch',
  ok: 'OK',
};

export interface AccountView extends Account {
  color: string;
  /** Today's place in the billing month (UTC): day number and days in the month. */
  day: number;
  monthDays: number;
}

/** One account's use of one metric this period, against its allowance. */
export interface Usage {
  a: AccountView;
  m: Metric;
  limit: number;
  per: 'day' | 'mo';
  price: number;
  used: number;
  forecast: number;
  pct: number;
  fpct: number;
  cost: number;
  fcost: number;
  st: Status;
  /** Free daily limits: the 30-day peak and its date. */
  peak: number | null;
  peakDay: string | null;
  basis: 'now' | 'today' | 'mtd';
  hard: boolean;
  /** No included amount (R2 Infrequent Access): billed from the first unit, never "near a limit". */
  payg: boolean;
  /** Account total per day, 30 days. */
  days: number[];
  /** Each resource's share of `used`, largest first. */
  parts: { r: Resource; v: number }[];
}

export const ACCOUNT_COLORS = [
  'var(--chart-1)',
  'var(--chart-6)',
  'var(--chart-5)',
  'var(--chart-3)',
  'var(--chart-9)',
  'var(--chart-4)',
];

function judge(a: AccountView, m: Metric, rs: Resource[], warn: number): Usage | null {
  const plan = a.plan === 'paid' ? m.paid : m.free;
  const mine = rs.filter((r) => r.series[m.key]);
  if (!plan || !mine.length) return null;
  const [limit, per, price = 0] = plan;
  const n = mine[0]?.series[m.key]?.length ?? 0;
  const last = n - 1;
  const days = Array.from({ length: n }, (_, i) => mine.reduce((s, r) => s + (r.series[m.key]?.[i] ?? 0), 0));
  const monthDays = days.slice(Math.max(0, n - a.day));
  let used: number;
  let forecast: number;
  let peak: number | null = null;
  let peakDay: string | null = null;
  let basis: Usage['basis'];
  if (m.kind === 'gauge') {
    // Billed as GB-months: the month's average size. So far the days this month; the rest of the
    // month assumed at today's size.
    used = days[last] ?? 0;
    const sofar = monthDays.reduce((x, y) => x + y, 0);
    forecast = (sofar + used * Math.max(0, a.monthDays - monthDays.length)) / a.monthDays;
    basis = 'now';
  } else if (per === 'day') {
    used = days[last] ?? 0;
    peak = Math.max(...days);
    peakDay = String(days.indexOf(peak));
    // Today is partial: scale it by the share of the UTC day gone.
    const now = new Date();
    const gone = Math.max(0.05, (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440);
    forecast = a.plan === 'free' && price === 0 ? Math.max(used / gone, peak) : used / gone;
    basis = 'today';
  } else {
    used = monthDays.reduce((x, y) => x + y, 0);
    forecast = (used / a.day) * a.monthDays;
    basis = 'mtd';
  }
  const hard = a.plan === 'free' && plan[2] === undefined;
  const over = (x: number) => Math.max(0, x - limit);
  let cost = hard ? 0 : over(used) * price;
  let fcost = hard ? 0 : over(forecast) * price;
  if (!hard && m.kind === 'gauge') {
    // Accrued so far: the GB-months stored to date less the allowance accrued to date.
    const sofar = monthDays.reduce((x, y) => x + y, 0) / a.monthDays;
    cost = Math.max(0, sofar - (limit * monthDays.length) / a.monthDays) * price;
  } else if (!hard && per === 'day') {
    cost = monthDays.reduce((s, v) => s + over(v), 0) * price;
    fcost = (cost / a.day) * a.monthDays;
  }
  const payg = limit === 0;
  const pct = payg ? 0 : used / limit;
  const fpct = payg ? 0 : forecast / limit;
  let st: Status;
  if (payg) st = 'ok';
  else if (hard && (pct >= 1 || (per === 'day' && (peak ?? 0) >= limit))) st = 'block';
  else if (pct >= 1) st = 'over';
  else if (fpct >= 1) st = 'soon';
  else if (pct >= warn / 100) st = 'watch';
  else st = 'ok';
  const partOf = (r: Resource) => {
    const s = r.series[m.key] ?? [];
    return m.kind === 'gauge' || per === 'day'
      ? (s[last] ?? 0)
      : s.slice(Math.max(0, n - a.day)).reduce((x, y) => x + y, 0);
  };
  return {
    a,
    m,
    limit,
    per,
    price,
    used,
    forecast,
    pct,
    fpct,
    cost,
    fcost,
    st,
    peak,
    peakDay,
    basis,
    hard,
    payg,
    days,
    parts: mine.map((r) => ({ r, v: partOf(r) })).sort((x, y) => y.v - x.v),
  };
}

/** A resource's numbers: its main metric's share of the allowance, and its share of the bill. */
/**
 * Without a detected or chosen plan, an account that went past a Free daily hard limit on any day
 * must be on Workers Paid (Free would have stopped it there).
 */
function inferPlan(d: AccountUsage): Account {
  if (d.account.planSource !== 'assumed') return d.account;
  const over = METRICS.some((m) => {
    const lim = m.free;
    if (lim?.[1] !== 'day' || lim[2] !== undefined) return false;
    const n = d.dates.length;
    return Array.from({ length: n }, (_, i) =>
      d.resources.reduce((s, r) => s + (r.series[m.key]?.[i] ?? 0), 0),
    ).some((v) => v > lim[0] * 1.02);
  });
  return over ? { ...d.account, plan: 'paid', planSource: 'inferred' } : d.account;
}

export interface ResourceInfo {
  /** The meter closest to its own cap ("Watch for"). */
  main: { key: string; u: Usage; v: number; share: number } | null;
  cost: number;
  fcost: number;
  /** Share of the account's allotment: every meter priced at list rates, summed, over the list
   *  value of the whole allotment. One formula for every product, so any two rows compare. */
  plan: number;
  /** The last 7 days' use against the 7 before, priced the same way (0.12 = +12%). */
  trend: number | null;
}

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
  labels: LabelsDoc;
  labelsOf: (r: Resource) => string[];
  prefs: Prefs;
  errors: { label: string; error: string }[];
  /** No token yet: the pages point to Settings. */
  empty: boolean;
}

export function useModel(): Model {
  const accounts = useAccounts();
  const prefs = usePrefs();
  const labels = useLabels();
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
        const sh = u.used ? v / u.used : 0;
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
      const out = { main, cost, fcost, plan, trend: prev > 0 ? now / prev - 1 : null };
      infoCache.set(r.id, out);
      return out;
    };
    const doc = labels.data ?? { labels: [], assign: {} };
    const known = new Set(doc.labels.map((l) => l.name));
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
      labels: doc,
      labelsOf: (r) => (doc.assign[r.id] ?? []).filter((n) => known.has(n)),
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
    labels.data,
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
export const pctText = (p: number) => `${p >= 10 ? '>999' : Math.round(p * 100)}%`;
export const usd = (v: number) => `$${v.toFixed(2)}`;
const priceText = (u: Usage) =>
  u.price < 0.001
    ? `$${(u.price * 1e6).toFixed(2)}/M`
    : `$${u.price}/${u.m.unit || 'unit'}${u.m.kind === 'gauge' ? '-month' : ''}`;
/** How a meter's forecast cost is worked out, for its tooltip. */
export function costNote(u: Usage): string {
  if (u.hard) return 'Free plan: a hard limit, never billed';
  const over = Math.max(0, u.forecast - u.limit);
  if (u.per === 'day') return `Each day's use past ${fmt(u.limit, u.m.unit)} × ${priceText(u)}, to month end`;
  const what =
    u.m.kind === 'gauge'
      ? `average ${fmt(u.forecast, u.m.unit)} this month`
      : `${fmt(u.forecast, u.m.unit)} by month end`;
  return `(${what} − ${fmt(u.limit, u.m.unit)} included) = ${fmt(over, u.m.unit)} × ${priceText(u)} = ${usd(u.fcost)} for the account`;
}
export const perText = (u: Usage) => (u.per === 'day' ? '/day' : u.m.kind === 'gauge' ? '' : '/mo');
export const sevColor = (st: Status) =>
  st === 'block' || st === 'over'
    ? 'var(--loss)'
    : st === 'soon' || st === 'watch'
      ? 'var(--warning)'
      : 'var(--gain)';
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

/** The end of the billing month, e.g. `Oct 31`. */
export function monthEnd(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const LABEL_COLORS = [
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
export const labelColor = (doc: LabelsDoc, name: string) =>
  LABEL_COLORS[(doc.labels.find((l) => l.name === name)?.c ?? 0) % LABEL_COLORS.length] as string;

/** `Billing Prod` → `billing-prod`: a label's name. */
export const labelSlug = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32);

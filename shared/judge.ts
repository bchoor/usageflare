/**
 * Judging one account's usage against its plan: used, forecast, cost and status per metric. Pure,
 * so the pages (src/model.ts) and the Worker's alert check (worker/watch.ts) judge alike.
 */
import { type Account, HOURLY_SLOTS, METRICS, type Metric, type Resource } from './catalog';

/** One account's read, as the Worker answers `/api/accounts/:id/usage`. */
export interface UsageRead {
  dates: string[];
  account: Account;
  resources: Resource[];
}

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
  /** The account's colour on the pages (empty in the Worker). */
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
  /** Account total per hour, `HOURLY_SLOTS` from `a.hoursFrom` (last one in progress); null without it. */
  hours: number[] | null;
  /** Each resource's share of `used`, largest first. */
  parts: { r: Resource; v: number }[];
}

/** A stored size billed as GB-months: the days this month so far, the rest at today's size. */
export function monthAvg(days: number[], a: AccountView): number {
  const sofar = days.slice(Math.max(0, days.length - a.day));
  const today = days[days.length - 1] ?? 0;
  return (sofar.reduce((x, y) => x + y, 0) + today * Math.max(0, a.monthDays - sofar.length)) / a.monthDays;
}

/** An overage as billed: rounded up to the meter's billing unit (or to the nearest one), when it has one. */
export const billed = (m: Metric, x: number) =>
  m.block && x > 0
    ? (m.round === 'nearest' ? Math.round(x / m.block) : Math.ceil(x / m.block - 1e-9)) * m.block
    : x;

export function judge(a: AccountView, m: Metric, rs: Resource[], warn: number): Usage | null {
  const plan = a.plan === 'paid' ? m.paid : m.free;
  const mine = rs.filter((r) => r.series[m.key]);
  if (!plan || !mine.length) return null;
  const [limit, per, price = 0] = plan;
  const n = mine[0]?.series[m.key]?.length ?? 0;
  const last = n - 1;
  const days = Array.from({ length: n }, (_, i) => mine.reduce((s, r) => s + (r.series[m.key]?.[i] ?? 0), 0));
  const monthDays = days.slice(Math.max(0, n - a.day));
  const hours =
    a.hoursFrom && m.kind !== 'gauge' && a.hourly?.includes(m.product)
      ? Array.from({ length: HOURLY_SLOTS }, (_, i) =>
          mine.reduce((s, r) => s + (r.hourly?.[m.key]?.[i] ?? 0), 0),
        )
      : null;
  let used: number;
  let forecast: number;
  let peak: number | null = null;
  let peakDay: string | null = null;
  let basis: Usage['basis'];
  if (m.kind === 'gauge') {
    // Billed as GB-months: the month's average size. So far the days this month; the rest of the
    // month assumed at today's size.
    used = days[last] ?? 0;
    forecast = monthAvg(days, a);
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
  const over = (x: number) => billed(m, Math.max(0, x - limit));
  let cost = hard ? 0 : over(used) * price;
  let fcost = hard ? 0 : over(forecast) * price;
  if (!hard && m.kind === 'gauge') {
    // Accrued so far: the GB-months stored to date less the allowance accrued to date.
    const sofar = monthDays.reduce((x, y) => x + y, 0) / a.monthDays;
    cost = billed(m, Math.max(0, sofar - (limit * monthDays.length) / a.monthDays)) * price;
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
    hours,
    parts: mine.map((r) => ({ r, v: partOf(r) })).sort((x, y) => y.v - x.v),
  };
}

/**
 * Without a detected or chosen plan, an account that went past a daily cap Free enforces on any day
 * must be on Workers Paid (Free would have stopped it there).
 */
export function inferPlan(d: UsageRead): Account {
  if (d.account.planSource !== 'assumed') return d.account;
  const over = METRICS.some((m) => {
    const lim = m.free;
    if (!m.enforced || lim?.[1] !== 'day' || lim[2] !== undefined) return false;
    const n = d.dates.length;
    return Array.from({ length: n }, (_, i) =>
      d.resources.reduce((s, r) => s + (r.series[m.key]?.[i] ?? 0), 0),
    ).some((v) => v > lim[0] * 1.02);
  });
  return over ? { ...d.account, plan: 'paid', planSource: 'inferred' } : d.account;
}

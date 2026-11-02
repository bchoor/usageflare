/**
 * Your own alert rules: one condition on one meter, like a price alert on one stock. A rule names
 * an account, a meter and, if it likes, one resource (else the account's total), then one of:
 *
 *   above / below  the meter's use in an hour, a day or the month is above (below) a number
 *   share          the period's use is past a % of the account's allowance
 *   change         yesterday moved a % against the 7 days before it (up or down), by a real amount
 *   xnormal        the last whole hour is × its normal hour, by a real amount
 *   momentum       a 14 day RSI of daily use is above (below) a level: a steady climb, not one day
 *   toCap          at the last 3 hours' pace it reaches its allowance within N hours
 *   silent         no use at all for N hours, where there was use before (a stopped job)
 *
 * Judged on the watchdog's own read of each account (every 15 minutes), so a rule costs no extra
 * call to Cloudflare and no KV write. A rule fires once, then waits until its reading is clearly
 * back (hysteresis) before it can fire again. The same code replays a rule over the history the
 * app already holds, so the editor shows how often it would have fired.
 * Pure: no I/O.
 */
import { type Account, HOURLY_SLOTS, METRIC, type Metric, PRODUCT, type Resource } from './catalog';
import { allowanceOf, moveOf } from './watchdog';

export const RULE_CONDS = [
  'above',
  'below',
  'share',
  'change',
  'xnormal',
  'momentum',
  'toCap',
  'silent',
] as const;
export type RuleCond = (typeof RULE_CONDS)[number];
export type RuleWindow = 'hour' | 'day' | 'month';
export type RuleDir = 'up' | 'down';

export interface Rule {
  /** `r_` and 8 hex. */
  id: string;
  on: boolean;
  name: string;
  acct: string;
  /** One resource; absent for the account's total. */
  rid?: string;
  metric: string;
  cond: RuleCond;
  /** The number the condition compares with, in its own unit (see `COND`). */
  value: number;
  /** above, below: the span the use is summed over. */
  window?: RuleWindow;
  /** change, momentum: which way. */
  dir?: RuleDir;
  created_at: string;
}

/** At most this many rules: each is judged on every check. */
export const MAX_RULES = 50;
const RSI_DAYS = 14;
const CHANGE_DAYS = 7;
const PACE_HOURS = 3;

export const COND: Record<RuleCond, { label: string; unit: string; hint: string; hourly?: boolean }> = {
  above: { label: 'Above', unit: '', hint: 'Use in the window is at or above this' },
  below: { label: 'Below', unit: '', hint: 'Use in the window is at or below this' },
  share: {
    label: '% of allowance',
    unit: '%',
    hint: "This period's use is past this share of the allowance",
  },
  change: { label: '% change', unit: '%', hint: `Yesterday against the ${CHANGE_DAYS} days before it` },
  xnormal: {
    label: '× normal',
    unit: '×',
    hint: 'The last whole hour against its normal hour',
    hourly: true,
  },
  momentum: { label: 'Momentum (RSI)', unit: '', hint: `${RSI_DAYS} day RSI of daily use, 0 to 100` },
  toCap: {
    label: 'Time to cap',
    unit: 'h',
    hint: 'At the last 3 hours’ pace, hours until the allowance',
    hourly: true,
  },
  silent: { label: 'Silent', unit: 'h', hint: 'No use at all for this many hours', hourly: true },
};

/** What a rule reads: the meter's daily and hourly use for its resource or account. */
export interface RuleSeries {
  m: Metric;
  /** Daily use, oldest first; the last is today so far. */
  days: number[];
  dates: string[];
  /** `HOURLY_SLOTS` long from `from`, the last in progress; null when the account has no hourly read. */
  hours: number[] | null;
  from: number;
  cap: { limit: number; per: 'day' | 'mo' } | null;
  move: number;
}

export function seriesOf(
  rule: Pick<Rule, 'acct' | 'rid' | 'metric'>,
  account: Account,
  resources: Resource[],
  dates: string[],
): RuleSeries | null {
  const m = METRIC[rule.metric];
  if (!m || m.kind !== 'sum' || account.id !== rule.acct) return null;
  const mine = resources.filter(
    (r) => r.acct === rule.acct && r.series[m.key] && (!rule.rid || r.id === rule.rid),
  );
  if (!mine.length) return null;
  const n = dates.length;
  const days = Array.from({ length: n }, (_, i) => mine.reduce((t, r) => t + (r.series[m.key]?.[i] ?? 0), 0));
  const from = account.hoursFrom ? Date.parse(account.hoursFrom) : Number.NaN;
  const byHour =
    Number.isFinite(from) &&
    (account.hourly ?? []).includes(m.product) &&
    mine.some((r) => r.hourly?.[m.key]?.length === HOURLY_SLOTS);
  const hours = byHour
    ? Array.from({ length: HOURLY_SLOTS }, (_, i) =>
        mine.reduce((t, r) => t + (r.hourly?.[m.key]?.[i] ?? 0), 0),
      )
    : null;
  return { m, days, dates, hours, from, cap: allowanceOf(m, account.plan), move: moveOf(m, account.plan) };
}

export interface RuleReading {
  /** What the rule read, in the condition's unit (a count, %, ×, RSI or hours). */
  value: number;
  /** What it was held against: the normal hour, the week before, the allowance; else 0. */
  ref: number;
  met: boolean;
  /** Clearly back: the rule may fire again. */
  clear: boolean;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  const k = s.length >> 1;
  return s.length % 2 ? (s[k] ?? 0) : ((s[k - 1] ?? 0) + (s[k] ?? 0)) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** Wilder's RSI over the last `RSI_DAYS` moves of `v`; null with too few days. */
export function rsi(v: number[]) {
  if (v.length < RSI_DAYS + 1) return null;
  const w = v.slice(-(RSI_DAYS + 1));
  let up = 0;
  let down = 0;
  for (let i = 1; i < w.length; i++) {
    const d = (w[i] ?? 0) - (w[i - 1] ?? 0);
    if (d > 0) up += d;
    else down -= d;
  }
  if (!up && !down) return 50;
  return down ? 100 - 100 / (1 + up / down) : 100;
}

/**
 * The rule read at one point: day `d` (index into `days`, today = last) and hour `h` (index into
 * `hours`, the hour in progress = last). Null when the meter can't answer it (no hourly read for
 * an hourly condition, no allowance for a share).
 */
export function readAt(rule: Rule, s: RuleSeries, d: number, h: number): RuleReading | null {
  const t = rule.value;
  const hourly =
    COND[rule.cond].hourly || ((rule.cond === 'above' || rule.cond === 'below') && rule.window === 'hour');
  if (hourly && !s.hours) return null;
  const H = s.hours ?? [];
  const month = (s.dates[d] ?? '').slice(0, 7);
  const monthUse = () => {
    let u = 0;
    for (let i = d; i >= 0 && (s.dates[i] ?? '').startsWith(month); i--) u += s.days[i] ?? 0;
    return u;
  };
  const up = rule.dir !== 'down';
  switch (rule.cond) {
    case 'above':
    case 'below': {
      const w = rule.window ?? 'day';
      const above = rule.cond === 'above';
      // Above counts what is in so far; below waits for a whole span (an hour or day just begun is low).
      const v =
        w === 'hour'
          ? above
            ? Math.max(H[h] ?? 0, H[h - 1] ?? 0)
            : (H[h - 1] ?? 0)
          : w === 'month'
            ? monthUse()
            : above
              ? (s.days[d] ?? 0)
              : (s.days[d - 1] ?? 0);
      return above
        ? { value: v, ref: t, met: v >= t, clear: v < t * 0.9 }
        : { value: v, ref: t, met: v <= t, clear: v > (t ? t * 1.1 : 0) };
    }
    case 'share': {
      if (!s.cap) return null;
      const used = s.cap.per === 'day' ? (s.days[d] ?? 0) : monthUse();
      const v = (used / s.cap.limit) * 100;
      return { value: v, ref: s.cap.limit, met: v >= t, clear: v < t - 5 };
    }
    case 'change': {
      const cur = s.days[d - 1] ?? 0;
      const base = mean(s.days.slice(Math.max(0, d - 1 - CHANGE_DAYS), d - 1));
      if (d - 1 - CHANGE_DAYS < 0) return null;
      const pct = base ? ((cur - base) / base) * 100 : cur ? Number.POSITIVE_INFINITY : 0;
      const moved = Math.abs(cur - base) >= s.move;
      const met = moved && (up ? pct >= t : pct <= -t);
      return { value: Number.isFinite(pct) ? pct : 1000, ref: base, met, clear: !met };
    }
    case 'xnormal': {
      const v = H[h - 1] ?? 0;
      const prior = s.days.slice(Math.max(0, d - 14), d);
      const normal = Math.max(median(H.slice(0, Math.max(1, h - 1))), mean(prior) / 24);
      const x = normal ? v / normal : 0;
      const met = x >= t && v - normal >= s.move;
      return { value: x, ref: normal, met, clear: x < t * 0.8 };
    }
    case 'momentum': {
      const r = rsi(s.days.slice(0, d));
      if (r === null) return null;
      return up
        ? { value: r, ref: 0, met: r >= t, clear: r < t - 5 }
        : { value: r, ref: 0, met: r <= t, clear: r > t + 5 };
    }
    case 'toCap': {
      if (!s.cap) return null;
      const at = s.from + h * 3_600_000;
      const now = new Date(at);
      const reset =
        s.cap.per === 'day'
          ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
          : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      // Use so far at hour h: the period's use now, less the hours after h.
      const after = sum(H.slice(h + 1));
      const used = Math.max(0, (s.cap.per === 'day' ? (s.days.at(-1) ?? 0) : monthUse()) - after);
      const pace = mean(H.slice(Math.max(0, h - PACE_HOURS), h));
      if (used >= s.cap.limit) return { value: 0, ref: s.cap.limit, met: true, clear: false };
      const left = pace > 0 ? (s.cap.limit - used) / pace : Number.POSITIVE_INFINITY;
      const before = left <= (reset - at) / 3_600_000;
      const met = before && left <= t;
      return {
        value: Number.isFinite(left) ? left : 9999,
        ref: s.cap.limit,
        met,
        clear: !before || left > t * 1.5,
      };
    }
    case 'silent': {
      let quiet = 0;
      for (let i = h - 1; i >= 0 && !(H[i] ?? 0); i--) quiet++;
      const had = sum(s.days.slice(Math.max(0, d - 7), d)) > 0 || H.slice(0, h).some((v) => v > 0);
      return { value: quiet, ref: 0, met: had && quiet >= t, clear: (H[h - 1] ?? 0) > 0 };
    }
  }
}

/** The rule now: the last day and the hour in progress. */
export const readNow = (rule: Rule, s: RuleSeries) => readAt(rule, s, s.days.length - 1, HOURLY_SLOTS - 1);

/**
 * How often the rule would have fired over the history held: the last 24 hours for an hourly
 * condition, else the last 14 days. Fires once, then waits until clear, as the watchdog does.
 */
export function replay(rule: Rule, s: RuleSeries): { fires: number; span: string } | null {
  const hourly =
    COND[rule.cond].hourly || ((rule.cond === 'above' || rule.cond === 'below') && rule.window === 'hour');
  const last = s.days.length - 1;
  const points: [number, number][] = hourly
    ? Array.from({ length: HOURLY_SLOTS - 1 }, (_, i) => {
        const h = i + 1;
        const at = new Date(s.from + h * 3_600_000).toISOString().slice(0, 10);
        const d = s.dates.lastIndexOf(at);
        return [d < 0 ? last : d, h];
      })
    : Array.from({ length: Math.min(14, last) }, (_, i) => [
        last - Math.min(14, last) + 1 + i,
        HOURLY_SLOTS - 1,
      ]);
  let armed = true;
  let fires = 0;
  let any = false;
  for (const [d, h] of points) {
    const r = readAt(rule, s, d, h);
    if (!r) continue;
    any = true;
    if (armed && r.met) {
      fires++;
      armed = false;
    } else if (!armed && r.clear) armed = true;
  }
  return any ? { fires, span: hourly ? '24 h' : '14 days' } : null;
}

/** The meter's name: `Workers Requests`. */
export const meterName = (key: string) => {
  const m = METRIC[key];
  return m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : key;
};

/** The condition in words: `above 1.2M a day`, `RSI at or over 70`. */
export function condText(rule: Rule, fmt: (v: number, unit: string) => string) {
  const unit = METRIC[rule.metric]?.unit ?? '';
  const v = rule.value;
  const up = rule.dir !== 'down';
  switch (rule.cond) {
    case 'above':
    case 'below':
      return `${rule.cond} ${fmt(v, unit)} ${rule.window === 'hour' ? 'an hour' : rule.window === 'month' ? 'this month' : 'a day'}`;
    case 'share':
      return `past ${v}% of the allowance`;
    case 'change':
      return `${up ? 'up' : 'down'} ${v}% on the week`;
    case 'xnormal':
      return `${v}× its normal hour`;
    case 'momentum':
      return `RSI ${up ? 'at or over' : 'at or under'} ${v}`;
    case 'toCap':
      return `runs out within ${v} h`;
    case 'silent':
      return `silent ${v} h`;
  }
}

/** The reading in words, for the alert: `1.4M requests (above 1.2M a day)`. */
export function readingText(rule: Rule, r: RuleReading, fmt: (v: number, unit: string) => string) {
  const unit = METRIC[rule.metric]?.unit ?? '';
  switch (rule.cond) {
    case 'above':
    case 'below':
      return fmt(r.value, unit);
    case 'share':
      return `${Math.round(r.value)}% of ${fmt(r.ref, unit)}`;
    case 'change':
      return `${r.value >= 0 ? '+' : '−'}${Math.round(Math.abs(r.value))}% (vs ${fmt(r.ref, unit)}/day)`;
    case 'xnormal':
      return `${r.value >= 10 ? Math.round(r.value) : r.value.toFixed(1)}× (vs ${fmt(r.ref, unit)}/h)`;
    case 'momentum':
      return `RSI ${Math.round(r.value)}`;
    case 'toCap':
      return r.value >= 9999 ? 'no pace' : `${Math.round(r.value)} h to ${fmt(r.ref, unit)}`;
    case 'silent':
      return `${r.value} h silent`;
  }
}

/** A name when the person gives none: `Workers Requests above 1.2M a day`. */
export const autoName = (rule: Rule, fmt: (v: number, unit: string) => string) =>
  `${meterName(rule.metric)} ${condText(rule, fmt)}`;

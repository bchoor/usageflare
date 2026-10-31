/**
 * The watchdog's judge: what is abnormal in one account's usage, measured against its own normal.
 * Caps are the odometer (how far you've gone); this is the speedometer next to how you usually
 * drive. It works beside the fixed levels (Watch at `prefs.warn`, 90%, 100%), never instead of them.
 *
 *   spike    one hour (of the last few, or the one in progress) at 5× its normal hour or more
 *   surge    the last 6 whole hours averaging 3× normal or more: a run, not one blip
 *   new      something with no history at all, now above the floor ("a = a, but z = 100")
 *   level    an account meter crossing Watch, 90% or 100% of its allowance this period
 *   runsOut  at the last 3 hours' pace an account meter runs past its allowance before it resets
 *   blind    the watchdog itself could not read an account for over an hour (worker/watchdog.ts)
 *
 * Normal is the larger of the median hour before the window and the 14 days before today, per
 * hour; the median ignores one-off spikes. Every velocity check also needs a real amount: a tenth
 * of an even hour's share of the meter's allowance (`floor`), so 3 → 15 calls never fires.
 * Pure: no I/O, the same code judges in the Worker's alarm and draws in the app.
 */
import { type Account, HOURLY_SLOTS, METRIC, type Metric, PRODUCT, type Resource } from './catalog';

export type WatchKind = 'spike' | 'surge' | 'new' | 'level' | 'runsOut' | 'blind';

export interface WatchEvent {
  /** One per thing that happened: the same spike seen on the next check has the same key. */
  key: string;
  kind: WatchKind;
  acct: string;
  /** The resource, or absent for an account meter (level, runsOut). */
  rid?: string;
  name: string;
  metric: string;
  /** When it happened: the hour (spike), the window's end (surge, new) or the check (level, runsOut). */
  at: string;
  /** What it read: the hour, the window's hourly average, or the period's use. */
  value: number;
  /** Its normal hour; or the allowance, for level and runsOut. */
  normal: number;
  /** `value / normal` (∞ as 0 for new); the share of the allowance for level and runsOut. */
  x: number;
  /** level: the crossed share in percent (75, 90, 100). runsOut: hours to the cap. */
  level?: number;
}

export const SPIKE_X = 5;
export const SURGE_X = 3;
export const SURGE_HOURS = 6;
/** Whole hours a spike is looked for in, besides the one in progress (a check can come late). */
export const SPIKE_HOURS = 3;
/** Floor for a meter with no allowance (CPU ms on Free, a payg meter). */
const BARE_FLOOR = 100;
const HISTORY = 14;

const median = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

/** A meter's allowance on the account's plan: amount and period; null when nothing is included. */
export function allowanceOf(m: Metric, plan: Account['plan']) {
  const a = plan === 'paid' ? m.paid : m.free;
  return a && a[0] > 0 ? { limit: a[0], per: a[1] } : null;
}

/** The amount an hour must reach before anything about it counts as abnormal. */
export function floorOf(m: Metric, plan: Account['plan']) {
  const a = allowanceOf(m, plan);
  return a ? a.limit / (a.per === 'day' ? 24 : 720) / 10 : BARE_FLOOR;
}

const hourIso = (from: number, slot: number) => new Date(from + slot * 3_600_000).toISOString().slice(0, 13);

/**
 * One series' velocity events: `hours` is `HOURLY_SLOTS` long from `from` (the last slot in
 * progress), `days` the daily series ending today.
 */
function velocity(
  hours: number[],
  days: number[],
  from: number,
  floor: number,
  id: { acct: string; rid: string; name: string; metric: string },
): WatchEvent[] {
  const out: WatchEvent[] = [];
  const last = HOURLY_SLOTS - 1; // the hour in progress
  const prior = days.slice(Math.max(0, days.length - 1 - HISTORY), days.length - 1);
  const daily = mean(prior) / 24;
  const before = (slot: number) => Math.max(median(hours.slice(0, Math.max(1, slot))), daily);
  const quiet = prior.every((v) => !v) && hours.slice(0, last - SURGE_HOURS).every((v) => !v);
  const base = { acct: id.acct, rid: id.rid, name: id.name, metric: id.metric };
  // new: nothing at all before, and now a real amount (the window counts, the hour in progress too).
  const recent = hours.slice(last - SURGE_HOURS);
  if (quiet && Math.max(...recent) >= floor) {
    const avg = mean(recent);
    out.push({
      ...base,
      key: `new:${id.rid}:${id.metric}:${hourIso(from, last - SURGE_HOURS).slice(0, 10)}`,
      kind: 'new',
      at: `${hourIso(from, last)}:00:00Z`,
      value: avg,
      normal: 0,
      x: 0,
    });
    return out;
  }
  if (quiet) return out;
  // spike: the worst of the last few whole hours and the one in progress, each against the hours before the window.
  const start = last - SPIKE_HOURS;
  const normal = before(start);
  let top = -1;
  for (let s = start; s <= last; s++) {
    const v = hours[s] ?? 0;
    if (v >= floor && v >= SPIKE_X * normal && (top < 0 || v > (hours[top] ?? 0))) top = s;
  }
  if (top >= 0) {
    const v = hours[top] ?? 0;
    out.push({
      ...base,
      key: `spike:${id.rid}:${id.metric}:${hourIso(from, top)}`,
      kind: 'spike',
      at: `${hourIso(from, top)}:00:00Z`,
      value: v,
      normal,
      x: normal ? v / normal : 0,
    });
  }
  // surge: the last whole hours together, against the hours before them.
  const win = hours.slice(last - SURGE_HOURS, last);
  const sNormal = before(last - SURGE_HOURS);
  const avg = mean(win);
  if (
    avg >= floor &&
    avg >= SURGE_X * sNormal &&
    win.filter((v) => v >= SURGE_X * sNormal).length > SURGE_HOURS / 2
  ) {
    out.push({
      ...base,
      key: `surge:${id.rid}:${id.metric}:${hourIso(from, last).slice(0, 10)}`,
      kind: 'surge',
      at: `${hourIso(from, last)}:00:00Z`,
      value: avg,
      normal: sNormal,
      x: sNormal ? avg / sNormal : 0,
    });
  }
  return out;
}

export interface WatchInput {
  account: Account;
  resources: Resource[];
  /** Dates of the daily series, oldest first; the last is today (UTC). */
  dates: string[];
  /** Watch at, in percent (`prefs.warn`). */
  warn: number;
  now?: number;
}

/** Everything abnormal in one account's read, at most one event of a kind per thing. */
export function watch({ account: a, resources, dates, warn, now = Date.now() }: WatchInput): WatchEvent[] {
  const out: WatchEvent[] = [];
  const from = a.hoursFrom ? Date.parse(a.hoursFrom) : Number.NaN;
  const hourly = new Set(a.hourly ?? []);
  const keys = new Set(resources.flatMap((r) => Object.keys(r.hourly ?? {})));
  for (const r of resources) {
    if (r.state === 'deleted' || !Number.isFinite(from) || !hourly.has(r.product)) continue;
    for (const [k, hours] of Object.entries(r.hourly ?? {})) {
      const m = METRIC[k];
      if (!m || m.kind !== 'sum' || hours.length !== HOURLY_SLOTS) continue;
      out.push(
        ...velocity(hours, r.series[k] ?? [], from, floorOf(m, a.plan), {
          acct: a.id,
          rid: r.id,
          name: r.name,
          metric: k,
        }),
      );
    }
  }
  // The account's meters (allowances pool per account): levels and pace to the cap.
  const day = new Date(now).getUTCDate();
  const today = dates.at(-1) ?? new Date(now).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const levels = [...new Set([warn, 90, 100])].sort((x, y) => x - y);
  for (const m of Object.values(METRIC)) {
    const cap = allowanceOf(m, a.plan);
    if (!cap || m.kind !== 'sum' || m.noApi) continue;
    const mine = resources.filter((r) => r.series[m.key]);
    if (!mine.length) continue;
    const n = mine[0]?.series[m.key]?.length ?? 0;
    const sumDay = (i: number) => mine.reduce((s, r) => s + (r.series[m.key]?.[i] ?? 0), 0);
    let used = 0;
    if (cap.per === 'day') used = sumDay(n - 1);
    else for (let i = Math.max(0, n - day); i < n; i++) used += sumDay(i);
    const share = used / cap.limit;
    const period = cap.per === 'day' ? today : month;
    const crossed = levels.filter((l) => share * 100 >= l).at(-1);
    const meter = `${PRODUCT[m.product]?.label ?? m.product} ${m.label}`;
    const base = { acct: a.id, name: meter, metric: m.key, value: used, normal: cap.limit, x: share };
    if (crossed !== undefined)
      out.push({
        ...base,
        key: `level:${a.id}:${m.key}:${period}:${crossed}`,
        kind: 'level',
        at: new Date(now).toISOString(),
        level: crossed,
      });
    if (share >= 1 || !Number.isFinite(from) || !keys.has(m.key) || !hourly.has(m.product)) continue;
    const last = HOURLY_SLOTS - 1;
    const pace = mean(
      [last - 3, last - 2, last - 1].map((s) => mine.reduce((t, r) => t + (r.hourly?.[m.key]?.[s] ?? 0), 0)),
    );
    const d = new Date(now);
    const reset =
      cap.per === 'day'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const left = (reset - now) / 3_600_000;
    if (pace >= floorOf(m, a.plan) && used + pace * left >= cap.limit)
      out.push({
        ...base,
        key: `runsOut:${a.id}:${m.key}:${period}`,
        kind: 'runsOut',
        at: new Date(now).toISOString(),
        level: Math.max(0, Math.round((cap.limit - used) / pace)),
      });
  }
  return out;
}

/** One line a person reads: `KV Reads on SESSIONS: 9× its normal hour`. */
export function describe(
  e: WatchEvent,
  fmt: (v: number, unit: string) => string = (v) => `${Math.round(v)}`,
  /** The account's name, put in front (a notification has no other place for it). */
  account?: string,
) {
  const line = says(e, fmt);
  return account && e.kind !== 'blind' ? `${account} · ${line}` : line;
}

function says(e: WatchEvent, fmt: (v: number, unit: string) => string) {
  const m = METRIC[e.metric];
  const meter = m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : e.metric;
  const unit = m?.unit ?? '';
  const x = e.x >= 10 ? `${Math.round(e.x)}×` : `${e.x.toFixed(1)}×`;
  switch (e.kind) {
    case 'spike':
      return `${meter} on ${e.name}: ${x} its normal hour (${fmt(e.value, unit)} vs ${fmt(e.normal, unit)})`;
    case 'surge':
      return `${meter} on ${e.name}: ${x} normal for ${SURGE_HOURS} hours (${fmt(e.value, unit)}/h vs ${fmt(e.normal, unit)}/h)`;
    case 'new':
      return `${meter} on ${e.name}: new, ${fmt(e.value, unit)}/h with no history`;
    case 'level':
      return `${meter}: ${Math.round(e.x * 100)}% of its allowance (${fmt(e.value, unit)} of ${fmt(e.normal, unit)})`;
    case 'runsOut':
      return `${meter}: at this pace it reaches its allowance in about ${e.level ?? 0} h, before it resets`;
    case 'blind':
      return `Can't read ${e.name} since ${e.at.slice(0, 16).replace('T', ' ')} UTC: nothing about it is checked until it can`;
  }
}

export const KIND_LABEL: Record<WatchKind, string> = {
  spike: 'Spike',
  surge: 'Surge',
  new: 'New mover',
  level: 'Limit',
  runsOut: 'Runs out',
  blind: "Can't see",
};

/** What each kind means, one line (Settings ▸ Notifications lists them). */
export const KIND_DETAIL: Record<WatchKind, string> = {
  spike: `One hour at ${SPIKE_X}× its normal or more`,
  surge: `${SURGE_HOURS} hours averaging ${SURGE_X}× normal or more`,
  new: 'Real use on something with no history',
  level: 'An account meter passes Watch, 90% or 100% of its allowance',
  runsOut: 'At this pace a meter runs out before it resets',
  blind: "The watchdog can't read an account for over an hour",
};

export const KINDS = Object.keys(KIND_LABEL) as WatchKind[];

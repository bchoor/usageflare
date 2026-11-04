/**
 * Burning fast: the watchdog's main alarm. A share of an account meter's limit used within a short
 * window ("10% of today's limit in 15 minutes") is a runaway, whatever the raw count: 1M KV reads
 * in 10 minutes is 10% of a 10M month and fires; 1M D1 rows read is 0.004% of 25B and stays quiet.
 * Every limit is judged as a daily budget: a daily limit is its own, a monthly one is the limit
 * over 30 days (50M a month is 1.67M a day). One set of dials then fits every meter.
 *
 * Windows of an hour or more read the account's hourly series. The 15 minute window reads the
 * difference from the watchdog's last read of the same account (each is read every 15 minutes),
 * kept in its own storage: no extra call to Cloudflare, no KV write.
 * Pure: no I/O.
 */
import { type Account, HOURLY_SLOTS, METRIC, PRODUCT, type Resource } from './catalog';
import { allowanceOf, type WatchEvent } from './watchdog';

const REQ = 'workers.req';
/** How far a Worker's requests must jump over its normal to count as the one that changed. */
export const JUMP = 2;

/** A Worker bound to the alarm's resource, with its requests in the window against its normal. */
export interface Writer {
  rid: string;
  name: string;
  /** Requests in the window. */
  v: number;
  /** Its normal for a window this long: the average hour of the day before, scaled. */
  normal: number;
  /** `v / normal` (0 without a normal). */
  x: number;
}

/**
 * Who wrote it: Cloudflare counts a bucket's (or database's, namespace's) operations, not which
 * Worker made them. The Workers bound to the resource are the candidates: the ones whose requests
 * jumped in the alarm's window first (most first), then the rest by requests. One bound Worker is certain; several, the best match.
 * `win` is the hourly slots the window covers; `got` overrides the window's requests per Worker
 * (the 15 minute alarm measures them from the last read).
 */
export function writersOf(
  resources: Resource[],
  rid: string,
  win: [number, number],
  mins: number,
  got?: Record<string, number>,
): Writer[] {
  const target = resources.find((r) => r.id === rid);
  if (!target || target.product === 'workers') return [];
  return resources
    .filter((r) => r.product === 'workers' && r.acct === target.acct && r.binds?.includes(rid))
    .map((r) => {
      const h = r.hourly?.[REQ] ?? [];
      let v = 0;
      for (let i = win[0]; i <= win[1]; i++) v += h[i] ?? 0;
      if (got && got[r.id] !== undefined) v = got[r.id] ?? 0;
      const before = h.slice(Math.max(0, win[0] - 24), win[0]);
      const avg = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
      const normal = (avg * mins) / 60;
      return { rid: r.id, name: r.name, v, normal, x: normal > 0 ? v / normal : 0 };
    })
    .sort((a, b) => {
      // A Worker whose traffic jumped (JUMP× its normal) is the writer; without one, the busiest.
      const ja = a.x >= JUMP;
      const jb = b.x >= JUMP;
      return ja !== jb ? (ja ? -1 : 1) : ja ? b.x - a.x : b.v - a.v;
    });
}

export interface BurnDial {
  /** Share of the limit, in percent. */
  pct: number;
  /** The window, in minutes: 15, 60, 360 or 1440. */
  mins: number;
}

export interface BurnSettings {
  on: boolean;
  /** The dials, as a share of a day's budget, fastest first. They apply to every limit. */
  day: BurnDial[];
  /**
   * Older builds judged monthly limits on these, as a share of the month. Kept (and saved as it
   * was) so a rollback still reads its dials; this build ignores them.
   */
  mo: BurnDial[];
}

/** The days a monthly limit is spread over for its daily budget. */
export const BUDGET_DAYS = 30;

/** A limit's daily budget: a daily limit as it is, a monthly one over `BUDGET_DAYS`. */
export const dailyBudget = (limit: number, per: 'day' | 'mo') =>
  per === 'day' ? limit : limit / BUDGET_DAYS;

export const BURN_WINDOWS = [15, 60, 360, 1440] as const;
export const BURN_DEFAULT: BurnSettings = {
  on: true,
  day: [
    { pct: 10, mins: 15 },
    { pct: 25, mins: 60 },
  ],
  mo: [
    { pct: 2, mins: 15 },
    { pct: 5, mins: 360 },
  ],
};

/** What the last read held, per meter: the period's use, and each resource's. */
export interface BurnSnap {
  at: number;
  meters: Record<string, { period: string; used: number; parts: Record<string, number> }>;
}

export const windowText = (mins: number) => (mins < 60 ? `${mins} min` : `${mins / 60} h`);

interface MeterNow {
  key: string;
  limit: number;
  per: 'day' | 'mo';
  period: string;
  used: number;
  parts: Record<string, number>;
  /** Account hourly use, `HOURLY_SLOTS` long, and each resource's; null without an hourly read. */
  hours: number[] | null;
  rhours: Record<string, number[]>;
}

/** Every capped account meter now: the period's use, split by resource, and its hours. */
function metersNow(a: Account, resources: Resource[], dates: string[], now: number): MeterNow[] {
  const out: MeterNow[] = [];
  const day = new Date(now).getUTCDate();
  const today = dates.at(-1) ?? new Date(now).toISOString().slice(0, 10);
  const hourly = new Set(a.hourly ?? []);
  const from = a.hoursFrom ? Date.parse(a.hoursFrom) : Number.NaN;
  for (const m of Object.values(METRIC)) {
    const cap = allowanceOf(m, a.plan);
    if (!cap || m.kind !== 'sum' || m.noApi) continue;
    const mine = resources.filter((r) => r.series[m.key]);
    if (!mine.length) continue;
    const parts: Record<string, number> = {};
    let used = 0;
    for (const r of mine) {
      const s = r.series[m.key] ?? [];
      const n = s.length;
      let v = 0;
      if (cap.per === 'day') v = s[n - 1] ?? 0;
      else for (let i = Math.max(0, n - day); i < n; i++) v += s[i] ?? 0;
      if (v > 0) parts[r.id] = v;
      used += v;
    }
    const byHour = Number.isFinite(from) && hourly.has(m.product);
    const rhours: Record<string, number[]> = {};
    let hours: number[] | null = null;
    if (byHour) {
      hours = new Array(HOURLY_SLOTS).fill(0);
      for (const r of mine) {
        const h = r.hourly?.[m.key];
        if (h?.length !== HOURLY_SLOTS) continue;
        rhours[r.id] = h;
        for (let i = 0; i < HOURLY_SLOTS; i++) hours[i] = (hours[i] ?? 0) + (h[i] ?? 0);
      }
    }
    out.push({
      key: m.key,
      limit: cap.limit,
      per: cap.per,
      period: cap.per === 'day' ? today : today.slice(0, 7),
      used,
      parts,
      hours,
      rhours,
    });
  }
  return out;
}

export interface BurnInput {
  account: Account;
  resources: Resource[];
  dates: string[];
  now?: number;
  prev?: BurnSnap | null;
  settings?: BurnSettings;
}

/** The burn alarms in one account's read, and what to keep for the next read's 15 minutes. */
export function burn({
  account: a,
  resources,
  dates,
  now = Date.now(),
  prev,
  settings = BURN_DEFAULT,
}: BurnInput): { events: WatchEvent[]; snap: BurnSnap } {
  const meters = metersNow(a, resources, dates, now);
  const snap: BurnSnap = {
    at: now,
    meters: Object.fromEntries(
      meters.map((x) => [x.key, { period: x.period, used: x.used, parts: x.parts }]),
    ),
  };
  const events: WatchEvent[] = [];
  if (!settings.on) return { events, snap };
  const from = a.hoursFrom ? Date.parse(a.hoursFrom) : Number.NaN;
  const last = HOURLY_SLOTS - 1;
  const hour = new Date(now).toISOString().slice(0, 13);
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  // Each Worker's requests since the last read, for the 15 minute alarm's writer.
  const reqNow = meters.find((x) => x.key === REQ);
  const reqPrev = prev?.meters[REQ];
  const reqDelta =
    reqNow && reqPrev && reqNow.period === reqPrev.period
      ? Object.fromEntries(
          Object.entries(reqNow.parts).map(([rid, v]) => [rid, Math.max(0, v - (reqPrev.parts[rid] ?? 0))]),
        )
      : undefined;
  for (const x of meters) {
    const budget = dailyBudget(x.limit, x.per);
    for (const dial of settings.day) {
      let burned = 0;
      let mins = dial.mins;
      let parts: Record<string, number> = {};
      let win: [number, number] = [last, last];
      let got: Record<string, number> | undefined;
      if (dial.mins < 60) {
        const p = prev?.meters[x.key];
        const ago = prev ? (now - prev.at) / 60_000 : 0;
        // Only a read close to the window's length counts: a late one would spread the burn thin.
        if (!p || p.period !== x.period || ago < dial.mins * 0.5 || ago > dial.mins * 2) continue;
        burned = x.used - p.used;
        mins = Math.round(ago);
        for (const [rid, v] of Object.entries(x.parts)) parts[rid] = v - (p.parts[rid] ?? 0);
        got = reqDelta;
      } else {
        if (!x.hours) continue;
        const k = Math.min(HOURLY_SLOTS, Math.round(dial.mins / 60));
        let first = last - k + 1;
        // A daily limit counts only today's hours: yesterday's use is gone at the reset.
        if (x.per === 'day' && Number.isFinite(from))
          first = Math.max(first, Math.ceil((dayStart - from) / 3_600_000));
        if (first > last) continue;
        win = [first, last];
        for (let i = first; i <= last; i++) burned += x.hours[i] ?? 0;
        parts = {};
        for (const [rid, h] of Object.entries(x.rhours)) {
          let v = 0;
          for (let i = first; i <= last; i++) v += h[i] ?? 0;
          if (v > 0) parts[rid] = v;
        }
      }
      const share = burned / budget;
      if (!(burned > 0) || share * 100 < dial.pct) continue;
      const top = Object.entries(parts).sort((p, q) => q[1] - p[1])[0];
      const by = top && top[1] > 0 ? { rid: top[0], share: top[1] / burned } : null;
      const rate = burned / (mins / 60);
      const m = METRIC[x.key];
      const ws = by ? writersOf(resources, by.rid, win, mins, got).filter((w) => w.v > 0) : [];
      const w = ws[0];
      const n2 = ws[1];
      events.push({
        key: `burn:${a.id}:${x.key}:${hour}`,
        kind: 'burn',
        acct: a.id,
        rid: by?.rid,
        name: m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : x.key,
        metric: x.key,
        at: new Date(now).toISOString(),
        value: burned,
        normal: budget,
        x: share,
        level: mins,
        cap: { used: x.used / x.limit, lands: 0, per: x.per },
        empties: rate > 0 ? Math.max(0, (x.limit - x.used) / rate) : undefined,
        by: by
          ? { name: resources.find((r) => r.id === by.rid)?.name ?? by.rid, share: by.share }
          : undefined,
        writer: w
          ? {
              rid: w.rid,
              name: w.name,
              v: w.v,
              x: w.x,
              sure: ws.length === 1,
              next: n2 ? { name: n2.name, x: n2.x } : undefined,
            }
          : undefined,
      });
      break; // one alarm per meter: the fastest dial that fired
    }
  }
  return { events, snap };
}

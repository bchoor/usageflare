/**
 * Pace: each account meter's rate over the header's window (6h, 12h, 24h from the hourly read; 7d
 * from the daily rows), carried forward to when it hits its cap. Allowances pool per account, so a
 * meter's pace is the account's; a resource shows the meter of its own that hits first, and its
 * hover says how much of that pace the resource is.
 */
import {
  baseOption,
  burnRate,
  ColorDot,
  cn,
  DetailsTable,
  durationText,
  LumenEChart,
  type Pace,
  type PaceWindow,
  paceHours,
  ShareMeter,
  TimeToCap,
  timeToCap,
  useChartTokens,
  useIsMobile,
} from '@columenlabs/lumen-ui';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@columenlabs/lumen-ui/ui/hover-card';
import type { ReactNode } from 'react';
import { HOURLY_SLOTS, PRODUCT, type Resource } from '../shared/catalog';
import { MetricChip } from './meters';
import { fmt, type Model, pctText, type Usage } from './model';
import { ProductIcon } from './products';

const HOUR = 3_600_000;

/** Rounds up to a plain step, so the chart's top label reads 120k, not 110,250. */
const niceCeil = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => v / p <= s) ?? 10) * p;
};

/** When the meter's allowance starts again: 00:00 UTC for a daily one, the 1st for the rest. */
export function resetAt(u: Usage, now = Date.now()): number {
  const d = new Date(now);
  return u.per === 'day' && u.m.kind !== 'gauge'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The window's complete samples: the last whole hours, or (7d, sizes, no hourly read) whole days. */
function windowOf(days: number[], hours: number[] | null | undefined, gauge: boolean, w: PaceWindow) {
  if (gauge) return { samples: days.slice(-8), per: 24, hourly: false };
  if (w !== '7d' && hours) {
    const h = paceHours(w);
    return { samples: hours.slice(HOURLY_SLOTS - 1 - h, HOURLY_SLOTS - 1), per: 1, hourly: true };
  }
  return { samples: days.slice(-8, -1), per: 24, hourly: false };
}

export interface MeterPace extends Pace {
  /** The rate came from hourly samples (else from whole days). */
  hourly: boolean;
}

const cache = new WeakMap<Usage, Map<PaceWindow, MeterPace | null>>();

/** An account meter's pace over `w`; null where nothing is included (pay as you go). */
export function paceOf(u: Usage, w: PaceWindow): MeterPace | null {
  const byW = cache.get(u) ?? new Map<PaceWindow, MeterPace | null>();
  cache.set(u, byW);
  const hit = byW.get(w);
  if (hit !== undefined) return hit;
  let out: MeterPace | null = null;
  if (!u.payg && u.limit > 0) {
    const gauge = u.m.kind === 'gauge';
    const s = windowOf(u.days, u.hours, gauge, w);
    const now = Date.now();
    const rate = burnRate(s.samples, { per: s.per, gauge });
    out = { ...timeToCap(rate, u.used, u.limit, (resetAt(u, now) - now) / HOUR), hourly: s.hourly };
  }
  byW.set(w, out);
  return out;
}

/** Soonest to the cap first; then the one landing highest at reset. */
export const urgency = (p: Pace | null) =>
  !p ? Number.POSITIVE_INFINITY : p.eta === 0 ? -1 : p.hits ? p.eta : 1e6 - p.atReset * 1e3;

/** The Hits limit filter and Group by buckets. */
export const PACE_BUCKETS = ['At cap', 'Within 6h', 'Within 24h', 'Before reset', 'Resets first', 'No cap'];
export function paceBucket(p: Pace | null): string {
  if (!p) return 'No cap';
  if (p.eta === 0) return 'At cap';
  if (!p.hits) return 'Resets first';
  return p.eta <= 6 ? 'Within 6h' : p.eta <= 24 ? 'Within 24h' : 'Before reset';
}

export interface ResourcePace {
  u: Usage;
  pace: MeterPace;
  /** This resource's share of the account meter's pace (0 to 1); of its use this period when the
   *  window is quiet. */
  part: number;
  /** It drives the pooled meter (`DRIVER_SHARE` of it or more): only then is the account's time its own. */
  drives: boolean;
}

/**
 * A resource shows its account meter's time to the cap only when it is at least this share of the
 * meter's pace: three operations in a bucket never read "At cap" because another bucket filled it.
 */
const DRIVER_SHARE = 0.05;

/** Why a resource's row does or doesn't carry its account's time to the cap. */
export function shareNote(r: Resource, x: ResourcePace) {
  return x.drives
    ? `The allowance is the whole account's: ${r.name} is ${pctText(x.part)} of this pace.`
    : `That is the whole account's meter. ${r.name} is ${pctText(x.part)} of it, too little to put the account's time on this row.`;
}

/** A resource's meters with their account pace: those it drives first, the one that hits first on top. */
export function resourcePaces(m: Model, r: Resource, w: PaceWindow): ResourcePace[] {
  const out: ResourcePace[] = [];
  for (const key of Object.keys(r.series)) {
    const u = m.usage.find((x) => x.a.id === r.acct && x.m.key === key);
    const pace = u && paceOf(u, w);
    if (!u || !pace) continue;
    const gauge = u.m.kind === 'gauge';
    // The account read this meter by the hour: a resource with no hourly rows used none of it.
    const own = windowOf(r.series[key] ?? [], u.hours ? (r.hourly?.[key] ?? []) : null, gauge, w);
    const mine = burnRate(own.samples, { per: own.per, gauge }).rate;
    const v = u.parts.find((x) => x.r.id === r.id)?.v ?? 0;
    const part = Math.max(0, Math.min(1, pace.rate > 0 ? mine / pace.rate : u.used > 0 ? v / u.used : 0));
    out.push({ u, pace, part, drives: part >= DRIVER_SHARE });
  }
  return out.sort((p, q) => Number(q.drives) - Number(p.drives) || urgency(p.pace) - urgency(q.pace));
}

/** A rate per hour with its unit: `4.1k/h`; a size grows per day: `+120 MB/day`. */
export function rateText(u: Usage, p: Pace): string {
  if (u.m.kind === 'gauge') {
    const d = p.rate * 24;
    return `${d < 0 ? '−' : '+'}${fmt(Math.abs(d), u.m.unit)}/day`;
  }
  return `${fmt(p.rate, u.m.unit)}/h`;
}

/** Where the window's numbers come from, for the hover cards. */
const basisText = (u: Usage, p: MeterPace, w: PaceWindow) =>
  p.hourly
    ? `last ${w}, whole hours`
    : u.m.kind === 'gauge'
      ? 'last 7 days (sizes are daily)'
      : `last 7 whole days${w === '7d' ? '' : ' (no hourly data)'}`;

/** One meter's pace in words: rate, cap, when, safe pace, spikes. */
function paceLines(u: Usage, p: MeterPace, w: PaceWindow): string[] {
  const reset = u.per === 'day' && u.m.kind !== 'gauge' ? '00:00 UTC' : 'the 1st';
  const lines = [
    `${rateText(u, p)} over the ${basisText(u, p, w)}.`,
    p.eta === 0
      ? `At its cap of ${fmt(u.limit, u.m.unit)}.`
      : p.thin
        ? `Too little use in the window to project against ${fmt(u.limit, u.m.unit)}.`
        : p.hits
          ? `Hits ${fmt(u.limit, u.m.unit)} in ${durationText(p.eta)}, before the reset at ${reset}.`
          : `Lands at ${pctText(p.atReset)} of ${fmt(u.limit, u.m.unit)} when it resets at ${reset}.`,
  ];
  if (p.eta > 0 && u.m.kind !== 'gauge') lines.push(`Safe pace: ${fmt(p.safe, u.m.unit)}/h until the reset.`);
  if (p.spikes)
    lines.push(
      `${p.spikes} lone spike${p.spikes === 1 ? '' : 's'} counted at 3× the median (${fmt(p.raw, u.m.unit)}/h undamped).`,
    );
  return lines;
}

/** Hover or focus `children` to see a resource's meters at the window's pace. */
function ResourcePaceCard({
  r,
  rows,
  w,
  children,
}: {
  r: Resource;
  rows: ResourcePace[];
  w: PaceWindow;
  children: ReactNode;
}) {
  const top = rows[0];
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the pace card for keyboards. */}
        <span tabIndex={0} className="inline-flex min-w-0 items-center outline-none">
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto min-w-72 max-w-[min(28rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ProductIcon id={r.product} />
          <b className="truncate font-medium text-sm">{r.name}</b>
          <span className="ml-auto text-muted-foreground text-xs">Pace, {w}</span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((x, i) => (
              <tr
                key={x.u.m.key}
                className={cn(i === 0 && x.drives && 'bg-muted/60', !x.drives && 'text-muted-foreground')}
              >
                <td className="py-1 pr-2 pl-3">
                  <MetricChip m={x.u.m} />
                </td>
                <td className="num py-1 pr-2 text-right" title="This resource's share of the account's pace">
                  {pctText(x.part)}
                </td>
                <td className="py-1 pr-3">
                  <TimeToCap pace={x.pace} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {top && (
          <div className="border-t px-3 py-1.5 text-xs">
            {paceLines(top.u, top.pace, w).map((l) => (
              <p key={l}>{l}</p>
            ))}
            <p className="text-muted-foreground">{shareNote(r, top)}</p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** Hits limit for a resource: its meter that hits first, named when it isn't the Watch for one. */
export function ResourcePaceCell({ m, r, w }: { m: Model; r: Resource; w: PaceWindow }) {
  const mobile = useIsMobile();
  const rows = resourcePaces(m, r, w);
  const top = rows[0];
  if (!top) return <span className="text-muted-foreground">—</span>;
  if (!top.drives)
    return (
      <ResourcePaceCard r={r} rows={rows} w={w}>
        <span className="text-muted-foreground">—</span>
      </ResourcePaceCard>
    );
  const same = m.info(r).main?.key === top.u.m.key;
  return (
    <ResourcePaceCard r={r} rows={rows} w={w}>
      <TimeToCap
        pace={top.pace}
        short={mobile}
        label={same || mobile || !top.pace.hits ? undefined : top.u.m.label}
      />
    </ResourcePaceCard>
  );
}

/** Hover or focus `children` to see one account meter's pace and who drives it. */
export function MeterPaceCard({ u, w, children }: { u: Usage; w: PaceWindow; children: ReactNode }) {
  const p = paceOf(u, w);
  if (!p) return <>{children}</>;
  const drivers = u.parts.slice(0, 3);
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the pace card for keyboards. */}
        <span tabIndex={0} className="inline-flex min-w-0 items-center outline-none">
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto min-w-72 max-w-[min(28rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ColorDot color={u.a.color} />
          <ProductIcon id={u.m.product} />
          <b className="truncate font-medium text-sm">
            {PRODUCT[u.m.product].label} {u.m.label}
          </b>
          <span className="ml-auto text-muted-foreground text-xs">{u.a.name}</span>
        </div>
        <div className="px-3 py-1.5 text-xs">
          {paceLines(u, p, w).map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        {drivers.length > 0 && (
          <div className="border-t px-3 py-1.5 text-xs">
            <p className="mb-1 text-muted-foreground">Most of it, this period</p>
            {drivers.map((d) => (
              <p key={d.r.id} className="flex items-center gap-2">
                <ProductIcon id={d.r.product} />
                <span className="min-w-0 truncate">{d.r.name}</span>
                <span className="num ml-auto">{u.used ? pctText(d.v / u.used) : '—'}</span>
              </p>
            ))}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** Hits limit for an account meter. */
export function MeterPaceCell({ u, w }: { u: Usage; w: PaceWindow }) {
  const mobile = useIsMobile();
  return (
    <MeterPaceCard u={u} w={w}>
      <TimeToCap pace={paceOf(u, w)} short={mobile} />
    </MeterPaceCard>
  );
}

/** Meters on pace to hit their cap before it resets, soonest first; those already there are left out. */
export const hitting = (us: Usage[], w: PaceWindow) =>
  us
    .map((u) => ({ u, p: paceOf(u, w) }))
    .filter((x): x is { u: Usage; p: MeterPace } => !!x.p && x.p.hits && x.p.eta > 0)
    .sort((a, b) => a.p.eta - b.p.eta);

/** The "On pace to hit a cap" card: one line per meter. */
export function PaceList({
  us,
  w,
  limit,
  showAccount,
}: {
  us: Usage[];
  w: PaceWindow;
  limit: number;
  showAccount?: boolean;
}) {
  const rows = hitting(us, w).slice(0, limit);
  if (!rows.length)
    return (
      <p className="p-3 text-muted-foreground text-sm">
        At the {w} pace, nothing reaches its cap before it resets.
      </p>
    );
  return (
    <DetailsTable
      head={[{ label: 'Meter', grow: true }, { label: 'Now', hideOnPhone: true }, { label: 'Hits limit' }]}
      rows={rows.map(({ u }) => ({
        key: `${u.a.id}:${u.m.key}`,
        cells: [
          <span
            key="n"
            className="inline-flex min-w-0 items-center gap-2"
            title={`${u.a.name} · ${PRODUCT[u.m.product].label} ${u.m.label}`}
          >
            {showAccount && <ColorDot color={u.a.color} />}
            <ProductIcon id={u.m.product} />
            <span className="truncate max-md:max-w-44">
              {PRODUCT[u.m.product].label} {u.m.label}
            </span>
          </span>,
          <ShareMeter key="s" value={u.pct} label={pctText(u.pct)} />,
          <MeterPaceCell key="p" u={u} w={w} />,
        ],
      }))}
    />
  );
}

/**
 * The drawer's pace chart for one account meter: the period so far, the window's pace carried to
 * the reset (dashed), the cap, and the window itself as a band.
 */
export function PaceChart({ u, w, height = 180 }: { u: Usage; w: PaceWindow; height?: number }) {
  const t = useChartTokens();
  const p = paceOf(u, w);
  if (!p) return <p className="text-muted-foreground text-sm">Pay as you go: no cap to reach.</p>;
  // To the minute, so a re-render (a hover, a refetch) hands the chart the same option and it
  // doesn't redraw and replay its animation under the tooltip.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const reset = resetAt(u, now);
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const past: [number, number][] = [];
  if (u.m.kind === 'gauge') {
    u.days.slice(-u.a.day).forEach((v, i, xs) => {
      past.push([midnight - (xs.length - 1 - i) * 24 * HOUR, v]);
    });
  } else if (u.per === 'day') {
    past.push([midnight, 0]);
    const from = u.a.hoursFrom ? Date.parse(u.a.hoursFrom) : null;
    let sum = 0;
    if (u.hours && from !== null)
      u.hours.forEach((v, i) => {
        const start = from + i * HOUR;
        if (start < midnight) return;
        sum += v;
        past.push([Math.min(now, start + HOUR), sum]);
      });
    past.push([now, Math.max(sum, u.used)]);
  } else {
    const days = u.days.slice(-u.a.day);
    let sum = 0;
    past.push([midnight - (days.length - 1) * 24 * HOUR, 0]);
    days.forEach((v, i) => {
      sum += v;
      past.push([Math.min(now, midnight - (days.length - 2 - i) * 24 * HOUR), sum]);
    });
  }
  const end = u.used + Math.max(p.rate, 0) * ((reset - now) / HOUR);
  const capAt = p.hits && p.eta > 0 ? now + p.eta * HOUR : null;
  const level =
    p.eta === 0 || p.atReset >= 0.9 ? 'var(--loss)' : p.atReset >= 0.75 ? 'var(--warning)' : t.muted;
  const unit = u.m.unit;
  const max = niceCeil(Math.max(u.limit * 1.05, end, ...past.map((x) => x[1])));
  return (
    <LumenEChart
      label={`${u.m.label}: this period so far and at the ${w} pace`}
      height={height}
      option={{
        ...baseOption(t),
        grid: { left: 48, right: 12, top: 16, bottom: 28 },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (typeof v === 'number' ? fmt(v, unit) : '—'),
        },
        xAxis: { type: 'time', min: past[0]?.[0], max: reset },
        yAxis: { type: 'value', min: 0, max, axisLabel: { formatter: (v: number) => fmt(v) } },
        series: [
          {
            name: 'So far',
            type: 'line',
            data: past,
            symbol: 'none',
            // No hover state: redrawing the line in it lost the line and its fill under the tooltip.
            emphasis: { disabled: true },
            itemStyle: { color: u.a.color },
            lineStyle: { width: 2, color: u.a.color },
            areaStyle: { color: u.a.color, opacity: 0.12 },
            markArea: {
              silent: true,
              itemStyle: { color: 'color-mix(in oklab, var(--muted-foreground) 10%, transparent)' },
              data: [[{ xAxis: Math.max(past[0]?.[0] ?? 0, now - paceHours(w) * HOUR) }, { xAxis: now }]],
            },
            markLine: {
              silent: true,
              symbol: 'none',
              label: { formatter: `cap ${fmt(u.limit, unit)}`, color: t.muted, position: 'insideEndTop' },
              lineStyle: { type: 'solid', color: t.muted, width: 1 },
              data: [{ yAxis: u.limit }],
            },
          },
          {
            name: `At the ${w} pace`,
            type: 'line',
            data: [
              [now, u.used],
              [reset, end],
            ],
            symbol: 'none',
            emphasis: { disabled: true },
            itemStyle: { color: level },
            lineStyle: { width: 2, type: 'dashed', color: level },
            ...(capAt
              ? {
                  markPoint: {
                    symbol: 'circle',
                    symbolSize: 8,
                    itemStyle: { color: level },
                    label: { show: false },
                    data: [{ coord: [capAt, u.limit] }],
                  },
                }
              : {}),
          },
        ],
      }}
    />
  );
}

/** The drawer's Pace section: the chart and the same words as the hover. */
export function PaceSection({ u, w, note }: { u: Usage; w: PaceWindow; note?: string }) {
  const p = paceOf(u, w);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <MetricChip m={u.m} />
        <TimeToCap pace={p} />
        <span className="ml-auto text-muted-foreground text-xs">{u.a.name}</span>
      </div>
      <PaceChart u={u} w={w} />
      {p && (
        <div className="text-xs">
          {paceLines(u, p, w).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {note && <p className="text-muted-foreground">{note}</p>}
        </div>
      )}
    </div>
  );
}

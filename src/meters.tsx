/**
 * A resource's meters on one line: the metric chip (coloured by its family), and a hover card
 * listing every meter with its value, share of the allowance and forecast cost. Rows stay one
 * line; the detail lives in the card.
 */
import {
  ColorDot,
  METER_LEVEL_COLOR,
  meterLevel,
  ShareMeter,
  type TrendChange,
  TrendValue,
} from '@columenlabs/lumen-ui';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@columenlabs/lumen-ui/ui/hover-card';
import { CircleDashed, CircleSlash } from 'lucide-react';
import type { ReactNode } from 'react';
import { FAMILY, METRICS, type Metric, PRODUCT, type Resource } from '../shared/catalog';
import {
  type AccountView,
  billCheck,
  dayLabel,
  fmt,
  lineGap,
  type Model,
  partNote,
  partShare,
  pctText,
  shareOf,
  type Usage,
  usd,
} from './model';
import { ProductIcon } from './products';

export interface MeterRow {
  key: string;
  m: Metric;
  u: Usage | null;
  v: number;
  share: number;
  fcost: number;
}

/** Every meter a resource has, closest to its limit first; then the product's meters with no API. */
export function metersOf(model: Model, r: Resource): MeterRow[] {
  const rows: MeterRow[] = [];
  for (const key of Object.keys(r.series)) {
    const u = model.usage.find((x) => x.a.id === r.acct && x.m.key === key);
    const v = u?.parts.find((p) => p.r.id === r.id)?.v;
    if (!u || v === undefined) continue;
    rows.push({ key, m: u.m, u, v, share: shareOf(u, v), fcost: u.fcost * partShare(u, r, v) });
  }
  rows.sort((a, b) => b.share - a.share || b.fcost - a.fcost);
  for (const m of METRICS)
    if (m.noApi && m.product === r.product) rows.push({ key: m.key, m, u: null, v: 0, share: 0, fcost: 0 });
  return rows;
}

/** The metric's name in a chip tinted by its family (Reads, Writes, Stored...). */
export function MetricChip({ m }: { m: Metric }) {
  const c = FAMILY[m.family].color;
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-1.5 text-xs"
      style={{
        background: `color-mix(in oklab, ${c} 12%, var(--card))`,
        borderColor: `color-mix(in oklab, ${c} 30%, var(--card))`,
        color: `color-mix(in oklab, ${c} 70%, var(--foreground))`,
      }}
    >
      <span aria-hidden className="size-1.5 rounded-[2px]" style={{ background: c }} />
      {m.label}
    </span>
  );
}

/** A small bar and the share, or "pay as you go" where nothing is included. */
export function ShareBar({ row }: { row: MeterRow }) {
  if (row.m.noApi) return <span className="text-muted-foreground text-xs">No usage API</span>;
  if (row.u?.payg) return <span className="text-muted-foreground text-xs">Pay as you go</span>;
  return <ShareMeter value={row.share} label={pctText(row.share)} />;
}

/** Hover or focus `children` to see every meter of `r`; `hl` marks the one the cell shows. */
export function MetersCard({
  model,
  r,
  hl,
  children,
}: {
  model: Model;
  r: Resource;
  hl?: string;
  children: ReactNode;
}) {
  const rows = metersOf(model, r);
  const a = model.account[r.acct];
  const info = model.info(r);
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the meters card for keyboards. */}
        <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 outline-none">
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto min-w-72 max-w-[min(28rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ProductIcon id={r.product} />
          <b className="truncate font-medium text-sm">{r.name}</b>
          {/* The main meter's change over the last 7 days (tables leave it to this card). */}
          <span className="ml-auto flex items-center gap-1 text-muted-foreground text-xs">
            7d <Trend7 change={info.change} unit={info.main?.u.m.unit} />
          </span>
          <span className="text-muted-foreground text-xs">
            {rows.length} meter{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((x, i) => (
              <tr key={x.key} className={(hl ? x.key === hl : i === 0) ? 'bg-muted/60' : undefined}>
                <td className="py-1 pr-2 pl-3">
                  <MetricChip m={x.m} />
                </td>
                <td className="num py-1 pr-2 text-right">{x.m.noApi ? '' : fmt(x.v, x.m.unit)}</td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  <ShareBar row={x} />
                </td>
                <td
                  className="num py-1 pr-3 text-right text-muted-foreground"
                  title={x.u && a?.plan === 'paid' ? partNote(x.u, r, x.v) : undefined}
                >
                  {a?.plan === 'paid' && x.fcost >= 0.005 ? usd(x.fcost) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {a?.plan === 'paid' &&
          rows
            .filter((x) => x.u && x.fcost >= 0.005)
            .map((x) => (
              <p key={x.key} className="border-t px-3 py-1.5 text-xs tabular-nums">
                <span className="text-muted-foreground">{x.m.label}: </span>
                {x.u && partNote(x.u, r, x.v)}
              </p>
            ))}
        <p className="border-t px-3 py-1.5 text-muted-foreground text-xs">
          Usage {planText(model.info(r).plan)} of the {a?.name ?? ''} allotment at list prices. Bars: share of
          each meter's allowance
          {a?.plan === 'free' ? ' (Free plan, daily limits)' : '; cost is the forecast to month end'}.
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The resource's details on hover: account, product, type, routes and what it is. */
/** Live resources have no status word; the filter and Status column read `Live`. */
export const stateLabel = (r: Resource) =>
  r.state === 'deleted' ? 'Deleted' : r.state === 'unbound' ? 'Unbound' : 'Live';

const shortDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** What a status means for this resource, for its hover card and drawer. */
export function stateNote(r: Resource): string | null {
  if (r.state === 'deleted')
    return `Gone from Cloudflare. Last seen ${r.lastSeen ? shortDay(r.lastSeen) : 'before this app remembered it'}; its usage still counts this month.`;
  if (r.state === 'unbound') return 'No Worker binds it (Pages projects aren’t checked).';
  return null;
}

/** A small chip after the name: Deleted (with its last-seen day) or Unbound; just the icon on a phone. */
export function StateChip({ r }: { r: Resource }) {
  if (!r.state) return null;
  const Icon = r.state === 'deleted' ? CircleSlash : CircleDashed;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-xs ${
        r.state === 'deleted' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
    >
      <Icon className="size-3" aria-label={stateLabel(r)} />
      <span className="max-md:hidden">
        {stateLabel(r)}
        {r.state === 'deleted' && r.lastSeen ? ` · ${shortDay(r.lastSeen)}` : ''}
      </span>
    </span>
  );
}

export function ResourceCard({ model, r, children }: { model: Model; r: Resource; children: ReactNode }) {
  const rows: [string, ReactNode][] = [
    ['Account', model.account[r.acct]?.name ?? r.acct],
    ['Product', PRODUCT[r.product].label],
  ];
  const note = stateNote(r);
  if (note) rows.push([stateLabel(r), note]);
  if (r.type) rows.push(['Type', r.type]);
  if (r.detail) rows.push(['Detail', r.detail]);
  if (r.routes?.length) rows.push(['Routes', r.routes.join(', ')]);
  return (
    <HoverCard openDelay={300} closeDelay={80}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto min-w-56 max-w-sm p-3">
        <div className="mb-2 flex items-center gap-2">
          <ProductIcon id={r.product} />
          <b className="truncate font-medium text-sm">{r.name}</b>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

/** A share of the allotment: `<1%` rather than a misleading 0%. */
export const planText = (p: number) => (p > 0 && p < 0.005 ? '<1%' : pctText(p));

/** A Usage share as a quiet bar (it is a size, not a warning); just the number on a phone. */
export function PlanMeter({ share }: { share: number }) {
  return (
    <>
      <ShareMeter
        className="max-md:hidden"
        value={share}
        label={planText(share)}
        color="color-mix(in oklab, var(--primary) 70%, transparent)"
      />
      <span className="num md:hidden">{planText(share)}</span>
    </>
  );
}

/** A meter's name and share of its own cap, tinted by the kit's meter levels (grey, amber, red). */
export function WatchChip({
  label,
  share,
  payg,
  phoneBare,
}: {
  label: ReactNode;
  share: number;
  payg?: boolean;
  /** A phone shows the share alone (the name is in the hover), so a narrow table keeps its columns. */
  phoneBare?: boolean;
}) {
  const level = payg ? 'ok' : meterLevel(share);
  const c = METER_LEVEL_COLOR[level];
  return (
    <span
      className="inline-flex h-5 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1.5 text-xs"
      style={
        level === 'ok'
          ? { background: 'var(--muted)' }
          : {
              background: `color-mix(in oklab, ${c} 18%, transparent)`,
              color: `color-mix(in oklab, ${c} 80%, var(--foreground))`,
            }
      }
    >
      <span className={phoneBare ? 'truncate max-md:hidden' : 'truncate max-md:max-w-16'}>{label}</span>
      <span className="num">{payg ? 'pay as you go' : pctText(share)}</span>
    </span>
  );
}

/** Usage: the resource's share of its account's allotment. */
export function UsageCell({ model, r }: { model: Model; r: Resource }) {
  return (
    <MetersCard model={model} r={r}>
      <PlanMeter share={model.info(r).plan} />
    </MetersCard>
  );
}

/** Watch for: the resource's meter closest to its own cap. */
export function WatchFor({ model, r, phoneBare }: { model: Model; r: Resource; phoneBare?: boolean }) {
  const x = model.info(r).main;
  if (!x) return <span className="text-muted-foreground">—</span>;
  return (
    <MetersCard model={model} r={r} hl={x.key}>
      <WatchChip label={x.u.m.label} share={x.share} payg={x.u.payg} phoneBare={phoneBare} />
    </MetersCard>
  );
}

/** Hover or focus `children` to see every meter of the account `us` belong to, closest to its cap first. */
export function AccountMetersCard({
  title,
  us,
  hl,
  children,
}: {
  title: ReactNode;
  us: Usage[];
  hl?: string;
  children: ReactNode;
}) {
  const rows = [...us].sort((p, q) => Number(p.payg) - Number(q.payg) || q.pct - p.pct);
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the meters card for keyboards. */}
        <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 outline-none">
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="max-h-96 w-auto min-w-72 max-w-md overflow-y-auto p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <b className="truncate font-medium text-sm">{title}</b>
          <span className="ml-auto text-muted-foreground text-xs">
            {rows.length} meter{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((u) => (
              <tr key={u.m.key} className={u.m.key === hl ? 'bg-muted/60' : undefined}>
                <td className="py-1 pr-2 pl-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <ProductIcon id={u.m.product} />
                    <MetricChip m={u.m} />
                  </span>
                </td>
                <td className="num py-1 pr-2 text-right">{fmt(u.used, u.m.unit)}</td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {u.payg ? (
                    <span className="text-muted-foreground text-xs">Pay as you go</span>
                  ) : (
                    <ShareMeter value={u.pct} label={pctText(u.pct)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * What Cloudflare billed an account this period, from its Billable Usage API: one number, an amber
 * dot when it's more than 10% off our estimate for the same days, and per product in the hover.
 */
export function BilledCell({ model, a }: { model: Model; a: AccountView }) {
  const c = billCheck(model.usage, a);
  if (!c)
    return (
      <span
        className="text-muted-foreground"
        title={
          a.billing === 'no-access'
            ? 'Add Billing Read to this account’s token to see what Cloudflare billed'
            : a.billing === 'not-covered'
              ? 'Cloudflare doesn’t report billed usage for this account'
              : 'Not read yet'
        }
      >
        —
      </span>
    );
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the billed card for keyboards. */}
        <span tabIndex={0} className="inline-flex items-center gap-1.5 outline-none">
          {c.gap && <ColorDot color="var(--warning)" className="size-1.5" />}
          <span className="num">{usd(c.billed)}</span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="max-h-96 w-auto min-w-72 max-w-md overflow-y-auto p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <b className="truncate font-medium text-sm">Billed by Cloudflare</b>
          <span className="ml-auto whitespace-nowrap text-muted-foreground text-xs">
            {c.through ? `${dayLabel(c.from)} – ${dayLabel(c.through)}` : `From ${dayLabel(c.from)}`}
          </span>
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="py-1 pr-2 pl-3 text-left font-normal">Product</th>
              <th className="py-1 pr-2 text-right font-normal">Billed</th>
              <th className="py-1 pr-3 text-right font-normal">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.key}>
                <td className="py-1 pr-2 pl-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {l.product && <ProductIcon id={l.product} />}
                    {l.label}
                  </span>
                </td>
                <td className="num py-1 pr-2 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    {lineGap(l) && <ColorDot color="var(--warning)" className="size-1.5" />}
                    {usd(l.billed)}
                  </span>
                </td>
                <td className="num py-1 pr-3 text-right text-muted-foreground">
                  {l.est === null ? '—' : usd(l.est)}
                </td>
              </tr>
            ))}
            <tr className="border-t font-medium">
              <td className="py-1 pr-2 pl-3">Total</td>
              <td className="num py-1 pr-2 text-right">{usd(c.billed)}</td>
              <td className="num py-1 pr-3 text-right text-muted-foreground">
                {c.est === null ? '—' : usd(c.est)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="border-t px-3 py-2 text-muted-foreground text-xs">
          {c.est === null
            ? 'This billing period doesn’t start on the 1st, so there’s no estimate to compare.'
            : 'Usage charges only, without the plan’s base fee. The estimate covers the same days.'}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The last 7 days against the 7 before: an arrow and a share, never a bare number. */
export function Trend7({ change, unit }: { change: TrendChange; unit?: string }) {
  return <TrendValue change={change} format={(v) => fmt(v, unit)} />;
}

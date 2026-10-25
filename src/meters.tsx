/**
 * A resource's meters on one line: the metric chip (coloured by its family), and a hover card
 * listing every meter with its value, share of the allowance and forecast cost. Rows stay one
 * line; the detail lives in the card.
 */
import { ShareMeter } from '@columenlabs/lumen-ui';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@columenlabs/lumen-ui/ui/hover-card';
import type { ReactNode } from 'react';
import { FAMILY, METRICS, type Metric, PRODUCT, type Resource } from '../shared/catalog';
import { costNote, fmt, type Model, pctText, sevColor, shareOf, type Usage, usd } from './model';
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
    rows.push({ key, m: u.m, u, v, share: shareOf(u, v), fcost: u.used ? (u.fcost * v) / u.used : 0 });
  }
  rows.sort((a, b) => b.share - a.share || b.fcost - a.fcost);
  for (const m of METRICS)
    if (m.noApi && m.product === r.product) rows.push({ key: m.key, m, u: null, v: 0, share: 0, fcost: 0 });
  return rows;
}

const tone = (share: number) => (share >= 1 ? 'over' : share >= 0.5 ? 'watch' : 'ok');

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
  return <ShareMeter value={row.share} label={pctText(row.share)} color={sevColor(tone(row.share))} />;
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
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the meters card for keyboards. */}
        <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 outline-none">
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto min-w-72 max-w-md p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ProductIcon id={r.product} />
          <b className="truncate font-medium text-sm">{r.name}</b>
          <span className="ml-auto text-muted-foreground text-xs">
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
                  title={x.u && a?.plan === 'paid' ? costNote(x.u) : undefined}
                >
                  {a?.plan === 'paid' && x.fcost >= 0.005 ? usd(x.fcost) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t px-3 py-1.5 text-muted-foreground text-xs">
          Share of the {a?.name ?? ''} allowance
          {a?.plan === 'free' ? ' (Free plan, daily limits)' : '; cost is the forecast to month end'}.
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The resource's details on hover: account, product, type, routes and what it is. */
export function ResourceCard({ model, r, children }: { model: Model; r: Resource; children: ReactNode }) {
  const rows: [string, ReactNode][] = [
    ['Account', model.account[r.acct]?.name ?? r.acct],
    ['Product', PRODUCT[r.product].label],
  ];
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

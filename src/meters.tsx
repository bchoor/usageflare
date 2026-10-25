/**
 * A resource's meters on one line: the metric chip (coloured by its family), and a hover card
 * listing every meter with its value, share of the allowance and forecast cost. Rows stay one
 * line; the detail lives in the card.
 */
import { METER_LEVEL_COLOR, meterLevel, ShareMeter } from '@columenlabs/lumen-ui';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@columenlabs/lumen-ui/ui/hover-card';
import type { ReactNode } from 'react';
import { FAMILY, METRICS, type Metric, PRODUCT, type Resource } from '../shared/catalog';
import { fmt, type Model, partNote, partShare, pctText, shareOf, type Usage, usd } from './model';
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
export function WatchChip({ label, share, payg }: { label: ReactNode; share: number; payg?: boolean }) {
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
      <span className="truncate max-md:max-w-16">{label}</span>
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
export function WatchFor({ model, r }: { model: Model; r: Resource }) {
  const x = model.info(r).main;
  if (!x) return <span className="text-muted-foreground">—</span>;
  return (
    <MetersCard model={model} r={r} hl={x.key}>
      <WatchChip label={x.u.m.label} share={x.share} payg={x.u.payg} />
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

/** The last 7 days against the 7 before: an arrow and a share, never a bare number. */
export function Trend7({ t }: { t: number | null }) {
  if (t === null) return <span className="text-muted-foreground">—</span>;
  const p = Math.round(t * 100);
  if (p === 0) return <span className="num text-muted-foreground">0%</span>;
  return (
    <span className="num whitespace-nowrap">
      {p > 0 ? '▲' : '▼'} {Math.abs(p)}%
    </span>
  );
}

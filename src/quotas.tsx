/**
 * An account's Limits: each meter's pooled quota, and which tag uses how much of it. A meter's
 * quota is the account's, shared by every resource that uses it, so a row here is one tag's
 * slice of one account meter. Grouped by product; each meter folds its tags under one rolled-up
 * line (the kit's sub-group) that reads the pool again from its rows (`poolShare`).
 */
import {
  ColorDot,
  DetailsTable,
  iconOf,
  meterValueTone,
  type PaceWindow,
  PaceWindowPicker,
  poolShare,
  ShareMeter,
  UnitValue,
  type ViewDomain,
} from '@columenlabs/lumen-ui';
import { Box, ChartColumn, DollarSign, Gauge, Server, Tag, Timer, TriangleAlert } from 'lucide-react';
import { PRODUCT, PRODUCTS, type Resource } from '../shared/catalog';
import { amountParts, DAY_HEAD, dayCells, dayFields } from './domains';
import {
  findTag,
  fmt,
  type Model,
  onUtcDay,
  pctText,
  perText,
  STATUS_LABEL,
  shareOf,
  tagColor,
  type Usage,
  UTC_DAYS,
  type UtcDay,
} from './model';
import { hitting, MeterPaceCell, PaceSection } from './pace';
import { MeterIcon, PRODUCT_ICON, ProductIcon } from './products';

export const NO_TAG = 'No tag';

/** One tag's slice of an account meter. */
export interface QuotaRow {
  u: Usage;
  tag: string;
  used: number;
  /** Its slice of the meter's quota (0 to 1): the meter line's stacked bar, never a tag's own %. */
  share: number;
  /** Its share of the meter's use (0 to 1; a meter's tags add up to 1). A tag has no quota. */
  ofUse: number;
  /** Its share of the forecast, on the same quota. */
  fshare: number;
  fcost: number;
  parts: { r: Resource; v: number }[];
  /** Its use today, yesterday and this month (UTC), each resource split between its tags the same way. */
  day: Record<UtcDay, number | null>;
}

export const meterName = (u: Usage) => `${PRODUCT[u.m.product].label} · ${u.m.label}`;

/**
 * Every meter of `us` split by tag. A resource with several tags is split evenly between
 * them, so a meter's tags add up to the meter; one with none counts under "No tag".
 */
export function quotaRows(m: Model, us: Usage[]): QuotaRow[] {
  const out: QuotaRow[] = [];
  for (const u of us) {
    const by = new Map<string, { v: number; parts: { r: Resource; v: number }[]; day: QuotaRow['day'] }>();
    for (const p of u.parts) {
      if (!(p.v > 0)) continue;
      const ls = m.tagsOf(p.r);
      const names = ls.length ? ls : [NO_TAG];
      for (const l of names) {
        const e = by.get(l) ?? { v: 0, parts: [], day: { 0: null, 1: null, mo: null } };
        e.v += p.v / names.length;
        e.parts.push({ r: p.r, v: p.v / names.length });
        for (const back of UTC_DAYS) {
          const d = onUtcDay(p.r.series[u.m.key], m.dates, back, u.m.kind === 'gauge');
          if (d !== null) e.day[back] = (e.day[back] ?? 0) + d / names.length;
        }
        by.set(l, e);
      }
    }
    for (const [tag, e] of by) {
      const of = u.used > 0 ? e.v / u.used : 0;
      out.push({
        u,
        tag,
        used: e.v,
        share: u.payg ? 0 : shareOf(u, e.v),
        ofUse: of,
        fshare: u.payg ? 0 : u.fpct * of,
        fcost: u.hard ? 0 : u.fcost * of,
        parts: e.parts.sort((a, b) => b.v - a.v),
        day: e.day,
      });
    }
  }
  return out;
}

const productOf = new Map(PRODUCTS.map((p) => [p.label, p]));
const poolKey = (q: QuotaRow) => `${q.u.a.id}|${q.u.m.key}`;
const colorOf = (m: Model, tag: string, acct?: string) =>
  tag === NO_TAG
    ? 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)'
    : tagColor(m.tags, tag, acct);

/**
 * Whether `qs` hold every tag of each meter they touch. A slice (a tag's group, or a tag filter)
 * has no quota of its own, so its lines leave quota, %, forecast and pace blank.
 */
function whole(qs: QuotaRow[]): boolean {
  const by = new Map<string, { u: Usage; v: number }>();
  for (const q of qs) {
    const e = by.get(poolKey(q)) ?? { u: q.u, v: 0 };
    e.v += q.used;
    by.set(poolKey(q), e);
  }
  return [...by.values()].every((e) => e.v >= e.u.used * 0.999);
}

/** A tag's share of its meter's use, plain: no bar or meter colours, since a tag has no cap. */
function UseShare({ q }: { q: QuotaRow }) {
  return (
    <span
      className="num text-muted-foreground text-xs"
      title={`${pctText(q.ofUse)} of ${meterName(q.u)} use`}
    >
      {pctText(q.ofUse)}
    </span>
  );
}

/** Its share of the quota: a bar in the kit's meter colours and the number. */
function QuotaShare({ share, payg }: { share: number; payg?: boolean }) {
  if (payg) return <span className="text-muted-foreground text-xs">Pay as you go</span>;
  return <ShareMeter value={share} label={pctText(share)} />;
}

export function quotaDomain(m: Model, w: PaceWindow): ViewDomain<QuotaRow> {
  // A meter line or group reads its pools again from its rows: one pool splits by tag, several
  // read the fullest.
  const pools = (qs: QuotaRow[]) =>
    poolShare(qs, { pool: poolKey, used: (q) => q.used, cap: (q) => (q.u.payg ? 0 : q.u.limit) });
  return {
    id: 'quotas',
    rowKey: (q) => `${poolKey(q)}|${q.tag}`,
    text: (q) => [q.tag, q.u.m.label, PRODUCT[q.u.m.product].label],
    fields: [
      {
        key: 'tag',
        label: 'Tag',
        icon: Tag,
        format: 'text',
        value: (q) => q.tag,
        color: (v) => colorOf(m, v),
        iconOf: (v) => {
          const icon = findTag(m.tags, v)?.icon;
          return icon ? iconOf(icon, Tag) : undefined;
        },
        filterable: true,
        groupable: true,
      },
      {
        key: 'product',
        label: 'Product',
        icon: Box,
        format: 'text',
        value: (q) => PRODUCT[q.u.m.product].label,
        color: (v) => productOf.get(v)?.color,
        iconOf: (v) => {
          const p = productOf.get(v);
          return p ? PRODUCT_ICON[p.id] : undefined;
        },
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'meter',
        label: 'Meter',
        icon: Gauge,
        format: 'text',
        value: (q) => meterName(q.u),
        filterable: true,
        hideOnPhone: true,
      },
      {
        key: 'used',
        label: 'Used',
        icon: ChartColumn,
        format: 'number',
        value: (q) => q.used,
        aggregate: 'sum',
        hideOnPhone: true,
        render: (q) => {
          const [n, unit] = amountParts(q.used, q.u.m.unit);
          return <UnitValue value={n} unit={unit} />;
        },
        // One meter sums with its unit; a product's meters count different things, so stay blank.
        rollRender: (qs, level) => {
          const ps = pools(qs).pools;
          if (ps.length !== 1 || !qs[0]) return null;
          // A meter line is the whole meter, even when a filter shows some of its tags.
          const used = level === 'fold' ? qs[0].u.used : (ps[0]?.used ?? 0);
          const [n, unit] = amountParts(used, qs[0].u.m.unit);
          return <UnitValue value={n} unit={unit} />;
        },
      },
      ...dayFields<QuotaRow>(
        (q, back) => ({ v: q.day[back], unit: q.u.m.unit, key: q.u.m.key }),
        // As Used: a meter line is the whole meter; one pool sums its tags; several stay blank.
        (back) => (qs, level) => {
          const q = qs[0];
          if (!q || pools(qs).pools.length !== 1) return null;
          const v =
            level === 'fold'
              ? onUtcDay(q.u.days, m.dates, back, q.u.m.kind === 'gauge')
              : qs.reduce<number | null>(
                  (t, x) => (x.day[back] === null ? t : (t ?? 0) + (x.day[back] ?? 0)),
                  null,
                );
          if (v === null) return null;
          const [n, unit] = amountParts(v, q.u.m.unit);
          return <UnitValue value={n} unit={unit} />;
        },
      ),
      {
        key: 'quota',
        label: 'Quota',
        icon: Server,
        format: 'number',
        value: (q) => (q.u.payg ? null : q.u.limit),
        empty: 'None',
        aggregate: 'max',
        hideOnPhone: true,
        // The quota is the meter's: only meter lines (and a whole meter's group) show it.
        render: () => null,
        rollRender: (qs, level) => {
          const ps = pools(qs).pools;
          const q = qs[0];
          if (ps.length !== 1 || !q || q.u.payg || (level !== 'fold' && !whole(qs))) return null;
          const [n, unit] = amountParts(q.u.limit, q.u.m.unit);
          return <UnitValue value={n} unit={`${unit}${perText(q.u)}`} />;
        },
      },
      {
        key: 'pct',
        label: 'Share',
        icon: Gauge,
        format: 'percent',
        // A tag row: its share of the meter's use. Only the meter has a quota, bar and levels.
        value: (q) => q.ofUse * 100,
        aggregate: 'max',
        render: (q) => <UseShare q={q} />,
        // A meter: its tags stacked on the quota. A product: its fullest meter.
        rollRender: (qs, level) => {
          if (level === 'fold') {
            const u = qs[0]?.u;
            if (!u) return null;
            if (u.payg) return <QuotaShare share={0} payg />;
            const segs = [...qs]
              .sort((a, b) => b.used - a.used)
              .map((q) => ({ value: q.share, label: q.tag }));
            const share = shareOf(u, u.used);
            return <ShareMeter value={share} label={pctText(share)} segments={segs} />;
          }
          if (!whole(qs)) return null;
          const { share, top } = pools(qs);
          if (!top) return null;
          if (top.cap <= 0) return <QuotaShare share={0} payg />;
          // A product (and the Total): its fullest meter's %, no bar; bars are per meter.
          const t = meterValueTone(share);
          const tone = t === 'loss' ? 'text-loss' : t === 'warning' ? 'text-warning' : '';
          return <span className={`num text-xs ${tone}`}>{pctText(share)}</span>;
        },
      },
      {
        key: 'fpct',
        label: 'Forecast',
        icon: ChartColumn,
        format: 'percent',
        value: (q) => (q.u.payg ? null : q.fshare * 100),
        aggregate: 'max',
        hideOnPhone: true,
        // A forecast % is of the quota, so it is the meter's, never a tag's.
        render: () => null,
        rollRender: (qs, level) => {
          const u = qs[0]?.u;
          // Drawn like the Share column beside it: the % with its number, not in a unit slot.
          if (level === 'fold')
            return u && !u.payg ? <span className="num text-xs">{pctText(u.fpct)}</span> : null;
          if (!whole(qs)) return null;
          const { share, top } = poolShare(qs, {
            pool: poolKey,
            used: (q) => q.fshare,
            cap: (q) => (q.u.payg ? 0 : 1),
          });
          return top && top.cap > 0 ? <span className="num text-xs">{pctText(share)}</span> : null;
        },
      },
      {
        key: 'cost',
        label: 'Extra cost',
        icon: DollarSign,
        format: 'price',
        value: (q) => (q.u.hard ? null : q.fcost),
        empty: 'Hard limit',
        aggregate: 'sum',
        hideOnPhone: true,
      },
      {
        key: 'pace',
        label: 'Hits limit',
        icon: Timer,
        format: 'number',
        // The pool hits its cap, not a label: only meter lines and groups show it.
        value: () => null,
        empty: '',
        aggregate: 'min',
        hideOnPhone: true,
        rollRender: (qs, level) => {
          if (level !== 'fold' && !whole(qs)) return null;
          const us = [...new Map(qs.map((q) => [poolKey(q), q.u])).values()];
          const first = hitting(us, w)[0]?.u ?? (us.length === 1 ? us[0] : undefined);
          return first ? <MeterPaceCell u={first} w={w} /> : null;
        },
      },
      {
        key: 'top',
        label: 'Biggest resource',
        icon: Server,
        format: 'text',
        value: (q) => q.parts[0]?.r.name ?? null,
        render: (q) => (
          <span className="text-muted-foreground text-xs">
            {q.parts[0]?.r.name}
            {q.parts.length > 1 ? ` +${q.parts.length - 1}` : ''}
          </span>
        ),
        hideOnPhone: true,
      },
      {
        key: 'status',
        label: 'Status',
        icon: TriangleAlert,
        format: 'text',
        value: (q) => STATUS_LABEL[q.u.st],
        filterable: true,
        hideOnPhone: true,
      },
    ],
    details: [
      {
        id: 'resources',
        label: 'Resources with this tag',
        icon: Server,
        open: true,
        count: (q) => q.parts.length,
        render: (q) => (
          <DetailsTable
            head={[
              { label: 'Resource', grow: true },
              { label: 'Used', right: true },
              ...DAY_HEAD,
              { label: '% of meter', right: true },
            ]}
            rows={q.parts.map((p) => ({
              key: p.r.id,
              cells: [
                <span key="n" className="inline-flex min-w-0 items-center gap-2">
                  <ProductIcon id={p.r.product} />
                  <span className="truncate">{p.r.name}</span>
                </span>,
                fmt(p.v, q.u.m.unit),
                ...dayCells(p.r.series[q.u.m.key], m.dates, q.u.m.unit, q.u.m.kind === 'gauge'),
                q.u.used > 0 ? pctText(p.v / q.u.used) : '—',
              ],
            }))}
          />
        ),
      },
      {
        id: 'pool',
        label: 'Every tag on this quota',
        icon: Gauge,
        open: false,
        render: (q) => {
          const all = quotaRows(m, [q.u]).sort((a, b) => b.used - a.used);
          return (
            <div className="flex flex-col gap-2">
              {!q.u.payg && (
                <ShareMeter
                  wide
                  value={shareOf(q.u, q.u.used)}
                  label={pctText(shareOf(q.u, q.u.used))}
                  segments={all.map((x) => ({
                    value: x.share,
                    label: x.tag,
                  }))}
                />
              )}
              <DetailsTable
                head={[
                  { label: 'Tag', grow: true },
                  { label: 'Used', right: true },
                  { label: '% of meter', right: true },
                ]}
                rows={all.map((x) => ({
                  key: x.tag,
                  cells: [
                    <span
                      key="n"
                      className={`inline-flex items-center gap-2 ${x.tag === q.tag ? 'font-medium' : ''}`}
                    >
                      <ColorDot color={colorOf(m, x.tag, x.u.a.id)} />
                      {x.tag}
                    </span>,
                    fmt(x.used, q.u.m.unit),
                    pctText(x.ofUse),
                  ],
                }))}
              />
            </div>
          );
        },
      },
      {
        id: 'pace',
        label: 'Pace of this quota',
        icon: Timer,
        open: true,
        render: (q) => (
          <div className="flex flex-col gap-2">
            <PaceWindowPicker className="self-start" />
            <PaceSection u={q.u} w={w} />
          </div>
        ),
      },
    ],
    subgroups: [
      {
        key: 'meter',
        label: 'Meter',
        icon: Gauge,
        under: (q) => meterName(q.u),
        // Under its product's group a meter says only its own name.
        title: (key, qs, groupBy) => (groupBy === 'product' && qs[0] ? qs[0].u.m.label : key),
        always: true,
        // Meters start folded: their tags open on a click.
        mark: (_k, qs) =>
          qs[0] ? (
            <MeterIcon metric={qs[0].u.m} icons={m.prefs.meterIcons} className="size-3.5 shrink-0" />
          ) : null,
        flat: ['tag'],
      },
    ],
  };
}

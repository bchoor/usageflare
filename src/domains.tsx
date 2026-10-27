/**
 * The two tables as Lumen view domains: resources (every Worker, namespace, bucket... across the
 * accounts) and limits (each account's use of each metric against its allowance). LumenLayout draws
 * their filter, Group by, sort, selection and details drawer from these.
 */
import {
  baseOption,
  ColorDot,
  DetailsTable,
  iconOf,
  LumenEChart,
  meterLevel,
  meterValueTone,
  type PaceWindow,
  PaceWindowPicker,
  ShareMeter,
  StackedColumns,
  TileSpark,
  UnitValue,
  useChartTokens,
  type ViewDomain,
  type ViewField,
} from '@columenlabs/lumen-ui';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import {
  Activity,
  Box,
  Building2,
  ChartColumn,
  CircleGauge,
  CircleSlash,
  DollarSign,
  Folder,
  Gauge,
  Layers,
  Link2,
  Server,
  Shield,
  Tag,
  Text,
  Timer,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import {
  CATEGORY,
  FAMILIES,
  FAMILY,
  METRIC,
  type Metric,
  PRODUCT,
  PRODUCTS,
  type Resource,
} from '../shared/catalog';
import {
  MetersCard,
  MetricChip,
  metersOf,
  ResourceCard,
  ShareBar,
  StateChip,
  stateLabel,
  stateNote,
  Trend7,
  UsageCell,
  WatchFor,
} from './meters';
import {
  findTag,
  fmt,
  gbUnit,
  type Model,
  partNote,
  pctParts,
  pctText,
  perText,
  SEVERITY,
  STATUS_LABEL,
  sevColor,
  shareOf,
  statusText,
  tagColor,
  tagNames,
  type Usage,
  usd,
} from './model';
import {
  hitting,
  MeterPaceCell,
  PaceSection,
  paceBucket,
  paceOf,
  ResourcePaceCell,
  resourcePaces,
  shareNote,
} from './pace';
import { ProductIcon } from './products';
import { notTaggable, setTags, TagPicker, TagSource } from './tags';

/** A view config with its defaults filled; the schema leaves the name to the caller. */
export const view = (c: Partial<CustomViewConfig> & { name: string }) =>
  ({ ...customViewConfigSchema.parse(c), name: c.name }) as CustomViewConfig;

const LEVEL_TEXT = { ok: 'Room', watch: 'Watch', alert: 'Near cap' } as const;
const shareStatus = (share: number | undefined) =>
  share === undefined ? 'No data' : share >= 1 ? 'Over allowance' : LEVEL_TEXT[meterLevel(share)];

/** A line of the last 30 days, in the row's account colour. */
export function Spark({ values, color }: { values: number[]; color: string }) {
  const t = useChartTokens();
  return (
    <div className="h-6 w-24">
      <LumenEChart
        label="Last 30 days"
        height={24}
        option={{
          ...baseOption(t),
          animation: false,
          grid: { left: 1, right: 1, top: 2, bottom: 2 },
          tooltip: { show: false },
          xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
          yAxis: { type: 'value', show: false, min: 'dataMin' },
          series: [
            {
              type: 'line',
              data: values,
              symbol: 'none',
              lineStyle: { width: 1.5, color },
              areaStyle: { color, opacity: 0.15 },
            },
          ],
        }}
      />
    </div>
  );
}

/** One line: the value, then its share of the allowance in brackets, coloured by how close it is. */
const UNIT_SHORT: Record<string, string> = { 'vCPU-min': 'vCPU-m' };
/** A meter's amount as number and unit, for `UnitValue`. */
export const amountParts = (v: number, unit: string): [string, string] =>
  unit === 'GB'
    ? (fmt(v, 'GB').split(' ') as [string, string])
    : unit === 'h' && v > 0 && v < 1
      ? [v.toFixed(2), 'h']
      : [fmt(v), UNIT_SHORT[unit] ?? unit];
const toneOf = (share: number, payg?: boolean) => (payg ? undefined : meterValueTone(share));

/** A share as one number in its unit slot: `%`, or `×` from ten times the cap (`pctText`). */
export function PctValue({ p, tone }: { p: number; tone?: ReturnType<typeof meterValueTone> }) {
  const [n, unit] = pctParts(p);
  return <UnitValue value={n} unit={unit} tone={tone} />;
}

/** Sizes (storage, memory-time) read as amounts by default; counts against a cap as a share. */
const AMOUNT_FIRST = new Set<string>(['stor', 'mem']);

/** One family cell: the amount or its share of the allowance, one number with its unit slot. */
function FamilyCell({ v, u, share, as }: { v: number; u: Usage; share: number; as: 'amount' | 'share' }) {
  const tone = toneOf(share, u.payg);
  if (as === 'share') {
    if (u.payg) return <UnitValue value={<span className="text-muted-foreground">PAYG</span>} />;
    return <PctValue p={share} tone={tone} />;
  }
  const [n, unit] = amountParts(v, u.m.unit);
  return <UnitValue value={n} unit={unit} tone={tone} />;
}

/** A family column's group or Total cell: amounts summed with their unit; a share worked out
 *  again as the rows' total over their accounts' allowance. Mixed units or meters stay blank. */
function familyRoll(m: Model, family: string, as: 'amount' | 'share') {
  return (rows: Resource[]) => {
    const parts = rows.map((r) => familyPart(m, r, family)).filter((x) => !!x);
    if (!parts.length) return null;
    const keys = new Set(parts.map((x) => x.u.m.key));
    const units = new Set(parts.map((x) => x.u.m.unit));
    const total = parts.reduce((t, x) => t + x.v, 0);
    if (as === 'amount') {
      if (units.size > 1) return null;
      const [n, unit] = amountParts(total, parts[0]?.u.m.unit ?? '');
      return <UnitValue value={n} unit={unit} />;
    }
    if (keys.size > 1) return null;
    const allowance = [...new Map(parts.map((x) => [x.u.a.id, x.u.limit])).values()].reduce(
      (a, b) => a + b,
      0,
    );
    if (!allowance) return null;
    const share = total / allowance;
    return <PctValue p={share} tone={toneOf(share)} />;
  };
}

/** Used against the allowance: a bar in the kit's meter colours, with the share beside it. */
export function Meter({ share, wide }: { share: number; wide?: boolean }) {
  // Wide meters stop at a short track: a full-width bar shouts even when there is room.
  return (
    <ShareMeter value={share} label={pctText(share)} wide={wide} className={wide ? 'max-w-48' : undefined} />
  );
}

/** Axis and tooltip numbers in one unit picked from the tallest column, so storage never reads 0.00 GB. */
function axisFmt(max: number, unit: string): (v: number) => string {
  const trim = (x: number) => +x.toPrecision(3);
  if (unit === 'GB') {
    const [u, f] = gbUnit(max);
    return (v) => (v === 0 ? '0' : `${trim(v / f)} ${u}`);
  }
  return (v) => fmt(v, unit);
}

/** Daily values of one or more series, stacked, with the dates under them. */
export function DailyColumns({
  dates,
  series,
  unit,
  label,
  height = 200,
}: {
  dates: string[];
  series: { name: string; color: string; values: number[] }[];
  unit: string;
  label: string;
  height?: number;
}) {
  const rows = dates.map((d, i) => ({
    date: d,
    ...Object.fromEntries(series.map((s, j) => [`s${j}`, s.values[i] ?? 0])),
  }));
  return (
    <StackedColumns
      rows={rows}
      x="date"
      parts={series.map((s, j) => ({ name: s.name, key: `s${j}`, fill: s.color }))}
      label={label}
      height={height}
      tick={(v) => v.slice(5)}
      fmt={axisFmt(
        Math.max(0, ...dates.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0))),
        unit,
      )}
      legend={series.length > 1}
    />
  );
}

/** `Workers · Requests`: a metric as the filter lists it. */
const metricName = (x: Metric | undefined) => (x ? `${PRODUCT[x.product].label} · ${x.label}` : '');

/** Hours to the cap where it hits before the reset (0 at it); sorts soonest first, the rest after. */
const etaValue = (p: { eta: number; hits: boolean } | null | undefined) => (p?.hits ? p.eta : null);

export function resourceDomain(
  m: Model,
  open: (id: string) => void,
  w: PaceWindow,
  phone = false,
  /** The account the page shows: its tag picker offers that account's own tags. */
  only?: string,
): ViewDomain<Resource> {
  const acct = (r: Resource) => m.account[r.acct];
  const main = (r: Resource) => m.info(r).main;
  // The meter this resource drives that hits first; none when it is a small part of every pool.
  const pace = (r: Resource) => resourcePaces(m, r, w).find((x) => x.drives);
  return {
    id: 'resources',
    rowKey: (r) => r.id,
    text: (r) => [r.name, acct(r)?.name ?? '', PRODUCT[r.product].label, ...m.tagsOf(r)],
    fields: [
      {
        key: 'name',
        label: 'Name',
        icon: Text,
        format: 'text',
        value: (r) => r.name,
        render: (r) => (
          <ResourceCard model={m} r={r}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <ProductIcon id={r.product} />
              <span className="truncate font-medium max-md:max-w-20">{r.name}</span>
              {r.type && (
                <span className="shrink-0 max-md:hidden rounded bg-muted px-1.5 text-muted-foreground text-xs">
                  {r.type}
                </span>
              )}
              <StateChip r={r} />
            </span>
          </ResourceCard>
        ),
      },
      {
        key: 'account',
        label: 'Account',
        icon: Building2,
        format: 'text',
        value: (r) => acct(r)?.name ?? r.acct,
        color: (v) => m.accounts.find((a) => a.name === v)?.color,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'category',
        label: 'Category',
        icon: Folder,
        format: 'text',
        value: (r) => CATEGORY[PRODUCT[r.product].cat].label,
        color: (v) => Object.values(CATEGORY).find((c) => c.label === v)?.color,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'product',
        label: 'Product',
        icon: Box,
        format: 'text',
        value: (r) => PRODUCT[r.product].label,
        color: (v) => PRODUCTS.find((p) => p.label === v)?.color,
        filterable: true,
        groupable: true,
        // A phone keeps Name, Usage and Watch for.
        hideOnPhone: true,
      },
      {
        key: 'tag',
        label: 'Tags',
        icon: Tag,
        format: 'text',
        value: (r) => m.tagsOf(r).join(', ') || null,
        values: (r) => m.tagsOf(r),
        color: (v) => tagColor(m.tags, v, only),
        hideOnPhone: true,
        iconOf: (v) => {
          const icon = findTag(m.tags, v, only)?.icon;
          return icon ? iconOf(icon, Tag) : undefined;
        },
        filterable: true,
        groupable: true,
        edit: {
          many: async (r, values) => setTags(m, [r.id], values),
          options: () => ({ inUse: tagNames(m.tags, only ? [only] : undefined), unused: [] }),
          note: (r) => {
            const why = notTaggable(m, r.id);
            return `Tags of ${acct(r)?.name ?? 'this account'}; the same name in another account filters with it.${why ? ` Kept in usageflare: ${why}.` : ''}`;
          },
        },
      },
      {
        // Where its tags are kept: Cloudflare, usageflare until moved, or here for good (not taggable).
        key: 'tagHome',
        label: 'Tags kept in',
        icon: Tag,
        format: 'text',
        value: (r) =>
          notTaggable(m, r.id)
            ? 'Not taggable'
            : m.tags.local[r.id]?.length
              ? 'usageflare'
              : m.tags.assign[r.id]?.length
                ? 'Cloudflare'
                : null,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        // Deleted (gone from its list) or Unbound (nothing binds it); a chip after the name shows it.
        key: 'status',
        label: 'Status',
        icon: CircleSlash,
        format: 'text',
        value: (r) => stateLabel(r),
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'type',
        label: 'Type',
        icon: Layers,
        format: 'text',
        value: (r) => r.type ?? null,
        values: (r) => [r.type ?? 'None'],
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'plan',
        label: 'Plan',
        icon: Shield,
        format: 'text',
        value: (r) => (acct(r)?.plan === 'paid' ? 'Workers Paid' : 'Free'),
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        // The meter closest to its limit, as a chip coloured by its family; +N and the hover card
        // show the rest.
        key: 'metric',
        label: 'Metric',
        icon: Gauge,
        format: 'text',
        value: (r) => (main(r) ? metricName(main(r)?.u.m) : null),
        values: (r) => metersOf(m, r).map((x) => metricName(x.m)),
        filterable: true,
        hideOnPhone: true,
        render: (r) => {
          const all = metersOf(m, r);
          const head = all[0];
          if (!head) return <span className="text-muted-foreground">—</span>;
          return (
            <MetersCard model={m} r={r} hl={head.key}>
              <MetricChip m={head.m} />
              {all.length > 1 && <span className="num text-muted-foreground text-xs">+{all.length - 1}</span>}
            </MetersCard>
          );
        },
      },
      {
        key: 'usage',
        label: 'Usage',
        icon: CircleGauge,
        format: 'percent',
        value: (r) => m.info(r).plan * 100,
        render: (r) => <UsageCell model={m} r={r} />,
      },
      {
        // The meter closest to its own cap, whatever the product: name and share, toned by level.
        key: 'watch',
        label: 'Watch for',
        icon: Gauge,
        format: 'percent',
        value: (r) => (main(r) ? (main(r)?.share ?? 0) * 100 : null),
        values: (r) => [shareStatus(main(r)?.share)],
        filterable: true,
        // On a phone the share alone, so Hits limit fits beside it.
        render: (r) => <WatchFor model={m} r={r} phoneBare />,
      },
      {
        // When the meter that hits first reaches its cap at the header's pace window.
        key: 'pace',
        // A phone's narrow table: the short header the column needs to fit.
        label: phone ? 'Hits' : 'Hits limit',
        icon: Timer,
        format: 'number',
        value: (r) => etaValue(pace(r)?.pace),
        values: (r) => {
          const x = pace(r);
          return [x ? paceBucket(x.pace) : resourcePaces(m, r, w).length ? 'Small share' : 'No cap'];
        },
        empty: 'Resets first',
        filterable: true,
        groupable: true,
        aggregate: 'min',
        rollRender: (rows) => {
          const first = rows
            .map((r) => pace(r))
            .filter((x) => !!x)
            .sort((p, q) => (etaValue(p.pace) ?? Infinity) - (etaValue(q.pace) ?? Infinity))[0];
          return first?.pace.hits ? <MeterPaceCell u={first.u} w={w} /> : null;
        },
        render: (r) => <ResourcePaceCell m={m} r={r} w={w} />,
      },
      {
        key: 'trend7',
        label: 'Trend 7d',
        icon: TrendingUp,
        format: 'percent',
        value: (r) => {
          const t = m.info(r).trend;
          return t === null ? null : t * 100;
        },
        hideOnPhone: true,
        render: (r) => <Trend7 change={m.info(r).change} unit={main(r)?.u.m.unit} />,
      },
      {
        key: 'used',
        label: 'Used',
        icon: Activity,
        format: 'number',
        value: (r) => main(r)?.v ?? null,
        render: (r) => {
          const x = main(r);
          return x ? <span className="num whitespace-nowrap">{fmt(x.v, x.u.m.unit)}</span> : '—';
        },
      },
      {
        key: 'share',
        label: 'Share of allowance',
        icon: Gauge,
        format: 'percent',
        value: (r) => {
          const x = main(r);
          return x ? x.share * 100 : null;
        },
        values: (r) => [shareStatus(main(r)?.share)],
        filterable: true,
        render: (r) => {
          const x = metersOf(m, r)[0];
          return x ? <ShareBar row={x} /> : '—';
        },
      },
      {
        key: 'trend',
        label: '30 days',
        icon: ChartColumn,
        format: 'text',
        value: () => null,
        hideOnPhone: true,
        render: (r) => {
          const x = main(r);
          const s = x ? r.series[x.key] : undefined;
          return s ? <Spark values={s} color={acct(r)?.color ?? 'var(--primary)'} /> : null;
        },
      },
      // One column per metric family: shown on a category tab, filled where a product has it. Each
      // reads as an amount or a share of the allowance (Edit table: Show as), the other in its card.
      ...FAMILIES.map((f) => {
        const amountFirst = AMOUNT_FIRST.has(f.id);
        const amount = {
          format: 'number' as const,
          value: (r: Resource) => familyPart(m, r, f.id)?.v ?? null,
          render: (r: Resource) => familyRender(r, 'amount'),
          aggregate: 'sum' as const,
          rollRender: familyRoll(m, f.id, 'amount'),
        };
        const share = {
          format: 'percent' as const,
          value: (r: Resource) => {
            const x = familyPart(m, r, f.id);
            return x ? x.share * 100 : null;
          },
          render: (r: Resource) => familyRender(r, 'share'),
          aggregate: 'sum' as const,
          rollRender: familyRoll(m, f.id, 'share'),
        };
        const familyRender = (r: Resource, as: 'amount' | 'share') => {
          const x = familyPart(m, r, f.id);
          if (!x) return <span className="text-muted-foreground">—</span>;
          return (
            <MetersCard model={m} r={r} hl={x.u.m.key}>
              <FamilyCell v={x.v} u={x.u} share={x.share} as={as} />
            </MetersCard>
          );
        };
        const opts = [
          { id: 'amount', label: 'Amount', field: amount },
          { id: 'share', label: '% of allowance', field: share },
        ];
        return {
          key: `fam_${f.id}`,
          label: f.label,
          icon: Activity,
          ...(amountFirst ? amount : share),
          showAs: amountFirst ? opts : [opts[1], opts[0]],
        } as ViewField<Resource>;
      }),
      {
        key: 'cost',
        label: 'Forecast cost',
        icon: DollarSign,
        format: 'price',
        value: (r) => (acct(r)?.plan === 'paid' ? m.info(r).fcost : null),
        empty: 'Free',
        hideOnPhone: true,
        aggregate: 'sum',
        render: (r) => {
          if (acct(r)?.plan !== 'paid') return <span className="text-muted-foreground">Free</span>;
          // Each meter's cost for this resource, with the sum that makes it.
          const note = metersOf(m, r)
            .filter((x) => x.u && x.fcost >= 0.005)
            .map((x) => `${x.m.label}: ${x.u ? partNote(x.u, r, x.v) : ''}`)
            .join('\n');
          return (
            <span className="num" title={note || undefined}>
              {usd(m.info(r).fcost)}
            </span>
          );
        },
      },
    ],
    details: [
      {
        id: 'tags',
        label: 'Tags',
        icon: Tag,
        open: true,
        count: (r) => m.tagsOf(r).length || null,
        render: (r) => (
          <div className="flex flex-col gap-1.5">
            <TagPicker m={m} ids={[r.id]} />
            <TagSource m={m} r={r} />
          </div>
        ),
      },
      {
        id: 'usage',
        label: 'Usage this period',
        icon: CircleGauge,
        open: true,
        render: (r) => <ResourceUsage m={m} r={r} />,
      },
      {
        id: 'pace',
        label: 'Pace',
        icon: Timer,
        open: true,
        render: (r) => {
          const x = pace(r) ?? resourcePaces(m, r, w)[0];
          return x ? (
            <div className="flex flex-col gap-2">
              <PaceWindowPicker className="self-start" />
              <PaceSection u={x.u} w={w} note={shareNote(r, x)} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No meter with a cap.</p>
          );
        },
      },
      {
        id: 'binds',
        label: 'Bindings',
        icon: Link2,
        open: true,
        count: (r) => r.binds?.length || null,
        render: (r) => <ResourceLinks m={m} ids={r.binds ?? []} open={open} />,
      },
      {
        id: 'usedby',
        label: 'Used by',
        icon: Server,
        open: true,
        count: (r) => usedBy(m, r).length || null,
        render: (r) => <ResourceLinks m={m} ids={usedBy(m, r)} open={open} />,
      },
      {
        id: 'source',
        label: 'Where this comes from',
        icon: Folder,
        render: (r) => (
          <DetailsTable
            head={[{ label: 'Field' }, { label: 'Value', grow: true }]}
            rows={[
              { key: 'ds', cells: ['Dataset', PRODUCT[r.product].source] },
              {
                key: 'acct',
                cells: [
                  'Account',
                  <span key="a" className="font-mono">
                    {r.acct}
                  </span>,
                ],
              },
              { key: 'route', cells: ['Routes', r.routes?.join(', ') || '—'] },
              { key: 'detail', cells: ['Detail', r.detail ?? '—'] },
              { key: 'status', cells: ['Status', [stateLabel(r), stateNote(r)].filter(Boolean).join(': ')] },
              {
                key: 'synced',
                cells: ['Synced', acct(r) ? new Date(acct(r)?.syncedAt ?? '').toLocaleTimeString() : '—'],
              },
            ]}
          />
        ),
      },
    ],
  };
}

/** A resource's metric in one family, with its value and share of the account's allowance. */
export function familyPart(m: Model, r: Resource, family: string) {
  const key = Object.keys(r.series).find((k) => METRIC[k]?.family === family);
  if (!key) return null;
  const u = m.usage.find((x) => x.a.id === r.acct && x.m.key === key);
  const v = u?.parts.find((p) => p.r.id === r.id)?.v;
  return u && v !== undefined ? { u, v, share: shareOf(u, v) } : null;
}

const usedBy = (m: Model, r: Resource) =>
  m.resources.filter((o) => o.acct === r.acct && o.binds?.includes(r.id)).map((o) => o.id);

function ResourceLinks({ m, ids, open }: { m: Model; ids: string[]; open: (id: string) => void }) {
  if (!ids.length) return <p className="text-muted-foreground text-sm">None.</p>;
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id) => {
        const r = m.resource[id];
        const [, product = 'workers', name = id] = id.split(':');
        return (
          <button
            key={id}
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
            onClick={() => r && open(id)}
            disabled={!r}
          >
            <ProductIcon id={product as Resource['product']} />
            <span className="flex-1 truncate">{name}</span>
            <span className="text-muted-foreground text-xs">
              {PRODUCT[product as Resource['product']]?.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Every metric of `r` on one line (its 30 days, this period, share of allowance); the picked one is charted below. */
function ResourceUsage({ m, r }: { m: Model; r: Resource }) {
  const keys = Object.keys(r.series);
  const a = m.account[r.acct];
  const [picked, setPicked] = useState<string>();
  if (!keys.length || !a)
    return <p className="text-muted-foreground text-sm">No usage in the last 30 days.</p>;
  const k0 = picked && keys.includes(picked) ? picked : (m.info(r).main?.key ?? keys[0]);
  const color = (k: string) => {
    const f = METRIC[k]?.family;
    return f ? FAMILY[f].color : a.color;
  };
  return (
    <div className="flex flex-col gap-3">
      <DetailsTable
        head={[
          { label: 'Metric', grow: true },
          { label: '30 days' },
          { label: 'This period', right: true },
          { label: 'Of limit', right: true },
        ]}
        selected={k0}
        onSelect={setPicked}
        rows={keys.map((k) => {
          const u = m.usage.find((x) => x.a.id === r.acct && x.m.key === k);
          const v = u?.parts.find((p) => p.r.id === r.id)?.v ?? 0;
          const met = METRIC[k];
          const share = u ? shareOf(u, v) : 0;
          return {
            key: k,
            cells: [
              <span key="n" className="inline-flex items-center gap-2 whitespace-nowrap font-sans">
                <ColorDot color={color(k)} />
                {met?.label ?? k}
              </span>,
              <span key="s" className="block w-12 md:w-16">
                <TileSpark values={r.series[k] ?? []} color={color(k)} />
              </span>,
              fmt(v, met?.unit),
              u ? (
                u.payg ? (
                  <span key="p" className="text-muted-foreground text-xs">
                    Pay as you go
                  </span>
                ) : (
                  // A phone drawer has room for the share, not its bar.
                  <span key="p">
                    <ShareMeter className="max-md:hidden" value={share} label={pctText(share)} />
                    <span className="md:hidden">{pctText(share)}</span>
                  </span>
                )
              ) : (
                '—'
              ),
            ],
          };
        })}
      />
      {k0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">
            {METRIC[k0]?.label ?? k0}, last 30 days
          </span>
          <DailyColumns
            dates={m.dates}
            series={[{ name: r.name, color: color(k0), values: r.series[k0] ?? [] }]}
            unit={METRIC[k0]?.unit ?? ''}
            label={`${r.name} daily ${METRIC[k0]?.label ?? ''}`}
            height={160}
          />
          {keys.length > 1 && (
            <span className="text-muted-foreground text-xs">Click a metric above to chart it.</span>
          )}
        </div>
      )}
    </div>
  );
}

export function limitDomain(m: Model, w: PaceWindow): ViewDomain<Usage> {
  return {
    id: 'limits',
    rowKey: (u) => `${u.a.id}|${u.m.key}`,
    text: (u) => [u.m.label, PRODUCT[u.m.product].label, u.a.name],
    fields: [
      {
        key: 'account',
        label: 'Account',
        icon: Building2,
        format: 'text',
        value: (u) => u.a.name,
        color: (v) => m.accounts.find((a) => a.name === v)?.color,
        filterable: true,
        groupable: true,
      },
      {
        key: 'category',
        label: 'Category',
        icon: Folder,
        format: 'text',
        value: (u) => CATEGORY[PRODUCT[u.m.product].cat].label,
        color: (v) => Object.values(CATEGORY).find((c) => c.label === v)?.color,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'product',
        label: 'Product',
        icon: Box,
        format: 'text',
        value: (u) => PRODUCT[u.m.product].label,
        color: (v) => PRODUCTS.find((p) => p.label === v)?.color,
        filterable: true,
        groupable: true,
      },
      {
        key: 'metric',
        label: 'Metric',
        icon: Activity,
        format: 'text',
        value: (u) => u.m.label,
        filterable: true,
      },
      {
        key: 'family',
        label: 'Metric family',
        icon: Layers,
        format: 'text',
        value: (u) => FAMILY[u.m.family].label,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'used',
        label: 'Used',
        icon: Activity,
        format: 'number',
        value: (u) => u.used,
        render: (u) => <span className="font-mono tabular-nums">{fmt(u.used, u.m.unit)}</span>,
      },
      {
        key: 'allowance',
        label: 'Allowance',
        icon: Shield,
        format: 'number',
        value: (u) => u.limit,
        render: (u) => (
          <span className="font-mono tabular-nums">
            {u.payg ? 'Pay as you go' : `${fmt(u.limit, u.m.unit)}${perText(u)}`}
          </span>
        ),
        hideOnPhone: true,
      },
      {
        key: 'pct',
        label: 'Used %',
        icon: Gauge,
        format: 'percent',
        value: (u) => u.pct * 100,
        render: (u) => <Meter share={u.pct} />,
      },
      {
        key: 'fpct',
        label: 'Forecast',
        icon: ChartColumn,
        format: 'percent',
        value: (u) => (u.basis === 'today' ? shareOf(u, u.peak ?? 0) * 100 : u.fpct * 100),
        render: (u) => (
          <span className="font-mono text-xs tabular-nums">
            {u.basis === 'today' ? `peak ${pctText(shareOf(u, u.peak ?? 0))}` : pctText(u.fpct)}
          </span>
        ),
      },
      {
        key: 'pace',
        label: 'Hits limit',
        icon: Timer,
        format: 'number',
        value: (u) => etaValue(paceOf(u, w)),
        values: (u) => [paceBucket(paceOf(u, w))],
        empty: 'Resets first',
        filterable: true,
        groupable: true,
        aggregate: 'min',
        rollRender: (us) => {
          const first = hitting(us, w)[0];
          return first ? <MeterPaceCell u={first.u} w={w} /> : null;
        },
        render: (u) => <MeterPaceCell u={u} w={w} />,
      },
      {
        key: 'cost',
        label: 'Extra cost',
        icon: DollarSign,
        format: 'price',
        value: (u) => (u.hard ? null : u.fcost),
        empty: 'Hard limit',
        aggregate: 'sum',
        hideOnPhone: true,
      },
      {
        key: 'status',
        label: 'Status',
        icon: TriangleAlert,
        format: 'text',
        value: (u) => STATUS_LABEL[u.st],
        tone: (u) => (SEVERITY[u.st] >= 3 ? 'loss' : SEVERITY[u.st] >= 1 ? 'amber' : 'gain'),
        filterable: true,
        groupable: true,
      },
      {
        key: 'plan',
        label: 'Plan',
        icon: Shield,
        format: 'text',
        value: (u) => (u.a.plan === 'paid' ? 'Workers Paid' : 'Free'),
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
    ],
    // Built-in cards for a Row of numbers, drawn by the page over the card's rows (`usageTile`).
    tiles: [
      { key: 'bill', label: 'Bill so far', icon: DollarSign },
      { key: 'forecast', label: 'Forecast', icon: TrendingUp },
      { key: 'watch', label: 'Watch for', icon: TriangleAlert },
      { key: 'resources', label: 'Resources', icon: Server },
      { key: 'plan', label: 'Plan', icon: Shield },
      { key: 'usage', label: 'Usage', icon: Gauge },
      { key: 'pace', label: 'Hits a cap soon', icon: Timer },
    ],
    details: [
      {
        id: 'who',
        label: 'Which resources use it',
        icon: Server,
        open: true,
        count: (u) => u.parts.length,
        render: (u) => (
          <DetailsTable
            head={[
              { label: 'Resource', grow: true },
              { label: 'Used', right: true },
              { label: 'Share', right: true },
            ]}
            rows={u.parts.map((p) => ({
              key: p.r.id,
              cells: [
                <span key="n" className="inline-flex items-center gap-2">
                  <ProductIcon id={p.r.product} />
                  {p.r.name}
                </span>,
                fmt(p.v, u.m.unit),
                u.used ? pctText(p.v / u.used) : '—',
              ],
            }))}
          />
        ),
      },
      {
        id: 'pace',
        label: 'Pace',
        icon: Timer,
        open: true,
        render: (u) => (
          <div className="flex flex-col gap-2">
            <PaceWindowPicker className="self-start" />
            <PaceSection u={u} w={w} />
          </div>
        ),
      },
      {
        id: 'daily',
        label: 'Daily, 30 days',
        icon: ChartColumn,
        open: true,
        render: (u) => (
          <DailyColumns
            dates={m.dates}
            series={[{ name: u.a.name, color: u.a.color, values: u.days }]}
            unit={u.m.unit}
            label={`${u.m.label} per day`}
            height={160}
          />
        ),
      },
      {
        id: 'why',
        label: 'Status',
        icon: TriangleAlert,
        open: true,
        render: (u) => (
          <p className="flex items-center gap-2 text-sm">
            <ColorDot color={sevColor(u.st)} />
            {statusText(u, m.dates)}
            {!u.hard && u.fcost > 0 && (
              <span className="text-muted-foreground">· about {usd(u.fcost)} extra this month</span>
            )}
          </p>
        ),
      },
    ],
  };
}

/** Usage this month so far, one line per series, with a 100% line: on pace to use the whole allotment. */
export function UsageLines({
  dates,
  series,
  height = 220,
}: {
  dates: string[];
  series: { name: string; color: string; values: (number | null)[] }[];
  height?: number;
}) {
  const t = useChartTokens();
  const first = dates.findIndex((d) => d.endsWith('-01'));
  const from = Math.max(first, 0);
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  return (
    <LumenEChart
      label="Usage this month, share of each account's allotment"
      height={height}
      option={{
        ...baseOption(t),
        grid: { left: 44, right: 12, top: 12, bottom: 44 },
        // One line, paged on a phone, so the legend never wraps onto the axis labels.
        legend: { type: 'scroll', bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: t.muted } },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (typeof v === 'number' ? pctText(v) : '—'),
        },
        xAxis: { type: 'category', data: dates.slice(from).map((d) => d.slice(5)), boundaryGap: false },
        yAxis: {
          type: 'value',
          min: 0,
          max: Math.ceil(max * 10) / 10,
          axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
        },
        series: series.map((s, i) => ({
          name: s.name,
          type: 'line',
          data: s.values.slice(from),
          symbol: 'none',
          lineStyle: { width: 2, color: s.color },
          itemStyle: { color: s.color },
          ...(i === 0
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { type: 'dashed', color: t.muted, width: 1 },
                  data: [{ yAxis: 1 }],
                },
              }
            : {}),
        })),
      }}
    />
  );
}

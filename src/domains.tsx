/**
 * The two tables as Lumen view domains: resources (every Worker, namespace, bucket... across the
 * accounts) and limits (each account's use of each metric against its allowance). LumenLayout draws
 * their filter, Group by, sort, selection and details drawer from these.
 */
import {
  baseOption,
  ColorDot,
  DetailsTable,
  LumenEChart,
  StackedColumns,
  useChartTokens,
  type ViewDomain,
} from '@columenlabs/lumen-ui';
import { Progress } from '@columenlabs/lumen-ui/ui/progress';
import { type CustomViewConfig, customViewConfigSchema } from '@columenlabs/lumen-ui-types/views';
import {
  Activity,
  Box,
  Building2,
  ChartColumn,
  CircleGauge,
  DollarSign,
  Folder,
  Gauge,
  Layers,
  Link2,
  Server,
  Shield,
  Tag,
  Text,
  TriangleAlert,
} from 'lucide-react';
import { CATEGORY, FAMILIES, FAMILY, METRIC, PRODUCT, PRODUCTS, type Resource } from '../shared/catalog';
import { LabelPicker, setLabels } from './labels';
import {
  fmt,
  labelColor,
  type Model,
  pctText,
  perText,
  SEVERITY,
  STATUS_LABEL,
  sevColor,
  statusText,
  type Usage,
  usd,
} from './model';
import { ProductIcon } from './products';

/** A view config with its defaults filled; the schema leaves the name to the caller. */
export const view = (c: Partial<CustomViewConfig> & { name: string }) =>
  ({ ...customViewConfigSchema.parse(c), name: c.name }) as CustomViewConfig;

const shareStatus = (share: number | undefined) =>
  share === undefined
    ? 'No data'
    : share >= 1
      ? 'Over allowance'
      : share >= 0.5
        ? 'Half or more'
        : 'Under half';

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
export function ValueShare({
  v,
  unit,
  share,
  title,
}: {
  v: number;
  unit: string;
  share: number;
  title: string;
}) {
  const st = share >= 1 ? 'over' : share >= 0.5 ? 'watch' : 'ok';
  return (
    <span className="whitespace-nowrap font-mono tabular-nums" title={title}>
      {fmt(v, unit)}{' '}
      <span style={{ color: st === 'ok' ? 'var(--muted-foreground)' : sevColor(st) }}>
        [{pctText(share)}]
      </span>
    </span>
  );
}

/** Used against the allowance: a bar coloured by status, with the share beside it. */
export function Meter({ share, status, wide }: { share: number; status: Usage['st']; wide?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${wide ? 'w-full' : ''}`}>
      <Progress
        value={Math.min(share, 1) * 100}
        className={`h-1.5 ${wide ? 'w-full' : 'w-16'} [&>[data-slot=progress-indicator]]:bg-(--progress-color)`}
        style={{ ['--progress-color' as string]: sevColor(status) }}
      />
      <span className="font-mono text-xs tabular-nums">{pctText(share)}</span>
    </span>
  );
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
      fmt={(v) => fmt(v, unit)}
      legend={series.length > 1}
    />
  );
}

export function resourceDomain(m: Model, open: (id: string) => void): ViewDomain<Resource> {
  const acct = (r: Resource) => m.account[r.acct];
  const main = (r: Resource) => m.info(r).main;
  return {
    id: 'resources',
    rowKey: (r) => r.id,
    text: (r) => [r.name, acct(r)?.name ?? '', PRODUCT[r.product].label, ...m.labelsOf(r)],
    fields: [
      {
        key: 'name',
        label: 'Name',
        icon: Text,
        format: 'text',
        value: (r) => r.name,
        render: (r) => (
          <span className="inline-flex min-w-0 items-center gap-2">
            <ProductIcon id={r.product} />
            <span className="truncate font-medium">{r.name}</span>
            {r.type && (
              <span className="rounded bg-muted px-1.5 text-muted-foreground text-xs">{r.type}</span>
            )}
          </span>
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
      },
      {
        key: 'label',
        label: 'Labels',
        icon: Tag,
        format: 'text',
        value: (r) => m.labelsOf(r).join(', ') || null,
        values: (r) => m.labelsOf(r),
        color: (v) => labelColor(m.labels, v),
        filterable: true,
        groupable: true,
        edit: {
          many: async (r, values) => setLabels(m, [r.id], values),
          options: () => ({ inUse: m.labels.labels.map((l) => l.name), unused: [] }),
          note: () => 'Labels group resources into projects across accounts.',
        },
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
        key: 'used',
        label: 'Used',
        icon: Activity,
        format: 'number',
        value: (r) => main(r)?.v ?? null,
        render: (r) => {
          const x = main(r);
          return x ? (
            <span className="whitespace-nowrap font-mono tabular-nums" title={x.u.m.label}>
              {fmt(x.v, x.u.m.unit)}
            </span>
          ) : (
            '—'
          );
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
          const x = main(r);
          return x ? (
            <Meter share={x.share} status={x.share >= 1 ? 'over' : x.share >= 0.5 ? 'watch' : 'ok'} />
          ) : (
            '—'
          );
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
      // One column per metric family: shown on a category tab, filled where a product has it.
      ...FAMILIES.map((f) => ({
        key: `fam_${f.id}`,
        label: f.label,
        icon: Activity,
        format: 'percent' as const,
        value: (r: Resource) => {
          const x = familyPart(m, r, f.id);
          return x ? x.share * 100 : null;
        },
        render: (r: Resource) => {
          const x = familyPart(m, r, f.id);
          if (!x) return <span className="text-muted-foreground">—</span>;
          return (
            <ValueShare
              v={x.v}
              unit={x.u.m.unit}
              share={x.share}
              title={`${PRODUCT[x.u.m.product].label} ${x.u.m.label.toLowerCase()}: ${pctText(x.share)} of the allowance`}
            />
          );
        },
      })),
      {
        key: 'cost',
        label: 'Forecast cost',
        icon: DollarSign,
        format: 'price',
        value: (r) => (acct(r)?.plan === 'paid' ? m.info(r).fcost : null),
        empty: 'Free',
        aggregate: 'sum',
      },
    ],
    details: [
      {
        id: 'labels',
        label: 'Labels',
        icon: Tag,
        open: true,
        count: (r) => m.labelsOf(r).length || null,
        render: (r) => <LabelPicker m={m} ids={[r.id]} />,
      },
      {
        id: 'usage',
        label: 'Usage this period',
        icon: CircleGauge,
        open: true,
        render: (r) => <ResourceUsage m={m} r={r} />,
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
  return u && v !== undefined ? { u, v, share: v / u.limit } : null;
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

function ResourceUsage({ m, r }: { m: Model; r: Resource }) {
  const keys = Object.keys(r.series);
  const a = m.account[r.acct];
  const k0 = m.info(r).main?.key ?? keys[0];
  if (!keys.length || !a)
    return <p className="text-muted-foreground text-sm">No usage in the last 30 days.</p>;
  return (
    <div className="flex flex-col gap-3">
      <DetailsTable
        head={[
          { label: 'Metric', grow: true },
          { label: 'This period', right: true },
          { label: 'Of allowance', right: true },
        ]}
        rows={keys.map((k) => {
          const u = m.usage.find((x) => x.a.id === r.acct && x.m.key === k);
          const v = u?.parts.find((p) => p.r.id === r.id)?.v ?? 0;
          const met = METRIC[k];
          return {
            key: k,
            cells: [met?.label ?? k, fmt(v, met?.unit), u ? pctText(v / u.limit) : '—'],
          };
        })}
      />
      {k0 && (
        <DailyColumns
          dates={m.dates}
          series={[{ name: r.name, color: a.color, values: r.series[k0] ?? [] }]}
          unit={METRIC[k0]?.unit ?? ''}
          label={`${r.name} daily ${METRIC[k0]?.label ?? ''}`}
          height={160}
        />
      )}
    </div>
  );
}

export function limitDomain(m: Model): ViewDomain<Usage> {
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
            {fmt(u.limit, u.m.unit)}
            {perText(u)}
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
        render: (u) => <Meter share={u.pct} status={u.st} />,
      },
      {
        key: 'fpct',
        label: 'Forecast',
        icon: ChartColumn,
        format: 'percent',
        value: (u) => (u.basis === 'today' ? ((u.peak ?? 0) / u.limit) * 100 : u.fpct * 100),
        render: (u) => (
          <span className="font-mono text-xs tabular-nums">
            {u.basis === 'today' ? `peak ${pctText((u.peak ?? 0) / u.limit)}` : pctText(u.fpct)}
          </span>
        ),
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

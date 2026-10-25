/**
 * The pages: Overview, Limits, Resources (every account, one account, or one label) and an
 * account's Overview. Each is a LumenLayout: its cards, widths and table settings are a saved view
 * (Edit layout), kept per page in the Worker's KV.
 */
import {
  apiJson,
  ColorDot,
  DetailsTable,
  DrawerSection,
  LumenDrawer,
  LumenLayout,
  type LumenLayoutCard,
  LumenSelector,
  LumenTabs,
  LumenWidget,
  NoteLine,
  Tile,
  TileRow,
  TileToggleGroup,
  useShell,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import type { CustomViewConfig } from '@columenlabs/lumen-ui-types/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Building2,
  ChartColumn,
  CircleAlert,
  ExternalLink,
  Gauge,
  KeyRound,
  Palette,
  Rows3,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import {
  CATEGORIES,
  type CategoryId,
  FAMILIES,
  METRIC,
  METRICS,
  PRODUCT,
  permissionsFor,
} from '../shared/catalog';
import { DailyColumns, limitDomain, Meter, resourceDomain, view } from './domains';
import { BulkBar, LabelForm, LabelMark } from './labels';
import {
  ACCOUNT_COLORS,
  type AccountView,
  dayLabel,
  fmt,
  type Model,
  monthEnd,
  pctText,
  perText,
  SEVERITY,
  sevColor,
  statusText,
  type Usage,
  usd,
  useModel,
} from './model';
import { CATEGORY_ICON, CategoryIcon, ProductIcon } from './products';

// ---------- Saved page layouts ----------

type PageId = 'overview' | 'account' | 'limits' | 'resources' | `resources-${CategoryId}`;

function useSavedView(page: PageId, fallback: CustomViewConfig) {
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: ['view', page],
    queryFn: () => apiJson<{ config: CustomViewConfig | null }>(`/api/views/${page}`, undefined, 'view'),
  });
  const save = useMutation({
    mutationFn: (config: CustomViewConfig) =>
      apiJson<{ config: CustomViewConfig }>(
        `/api/views/${page}`,
        { method: 'PUT', body: JSON.stringify(config) },
        'view.put',
      ),
    onMutate: (config) => qc.setQueryData(['view', page], { config }),
  });
  const reset = useMutation({
    mutationFn: () => fetch(`/api/views/${page}`, { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(['view', page], { config: null }),
  });
  return {
    config: saved.data?.config ?? fallback,
    onConfigChange: (c: CustomViewConfig) => save.mutate(c),
    onReset: saved.data?.config ? () => reset.mutate() : undefined,
  };
}

// ---------- Shared bits ----------

const sevClass = (st: Usage['st']) =>
  SEVERITY[st] >= 3 ? 'text-loss' : SEVERITY[st] >= 1 ? 'text-warning' : 'text-gain';

export function StatusPill({ u, dates }: { u: Usage; dates: string[] }) {
  return (
    <span
      className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 font-semibold text-[11px]"
      style={{ color: sevColor(u.st), background: `color-mix(in oklab, ${sevColor(u.st)} 14%, transparent)` }}
    >
      <ColorDot color={sevColor(u.st)} className="size-1.5" />
      {statusText(u, dates)}
    </span>
  );
}

const accountBill = (m: Model, a: AccountView) => {
  const xs = m.usage.filter((u) => u.a.id === a.id);
  const base = a.plan === 'paid' ? 5 : 0;
  return {
    mtd: (a.plan === 'paid' ? (5 * a.day) / a.monthDays : 0) + xs.reduce((s, u) => s + u.cost, 0),
    fc: base + xs.reduce((s, u) => s + u.fcost, 0),
    base,
  };
};

const worst = (us: Usage[]) => [...us].sort((p, q) => SEVERITY[q.st] - SEVERITY[p.st] || q.fpct - p.fpct)[0];

/** What a page shows while data loads, or before any token exists. */
function Waiting({ m, crumbs }: { m: Model; crumbs: { label: ReactNode }[] }) {
  const shell = useShell();
  return (
    <LumenLayout
      crumbs={crumbs}
      intro={
        m.empty ? (
          <NoteLine
            icon={KeyRound}
            title="Add a Cloudflare API token to start"
            note="usageflare reads each account the token can see. Create a read-only token, then paste it in Settings."
            action={
              <Button size="sm" onClick={() => shell.openSettings('tokens')}>
                Open Settings
              </Button>
            }
          />
        ) : m.error ? (
          <NoteLine
            icon={CircleAlert}
            title="Couldn't load usage"
            note={String((m.error as Error).message ?? m.error)}
          />
        ) : (
          <p className="text-muted-foreground text-sm">Reading your Cloudflare accounts…</p>
        )
      }
    />
  );
}

/** Errors a token or dataset reported, so a missing scope never reads as zero usage. */
function Problems({ m, acct }: { m: Model; acct?: string }) {
  const shell = useShell();
  const missing = m.accounts.filter((a) => (!acct || a.id === acct) && a.missing.length);
  if (!m.errors.length && !missing.length) return null;
  const perms = permissionsFor(missing.flatMap((a) => a.missing));
  return (
    <NoteLine
      icon={TriangleAlert}
      title="Some numbers can't be read"
      note={[
        ...m.errors.map((e) => `Token ${e.label}: ${e.error}`),
        ...missing.map((a) => `${a.name}: no access to ${a.missing.join(', ')}`),
        ...(perms.length ? [`Edit the token in Cloudflare and add ${perms.join(', ')}`] : []),
      ].join(' · ')}
      action={
        <Button size="sm" variant="outline" onClick={() => shell.openSettings('tokens')}>
          Tokens
        </Button>
      }
    />
  );
}

/** A card in a saved layout that the page draws itself. */
function pageCard(
  id: string,
  title: string,
  icon: LumenLayoutCard['icon'],
  body: ReactNode,
  tools?: ReactNode,
): LumenLayoutCard {
  return {
    id,
    title,
    icon,
    frame: ({ controls }) => (
      <LumenWidget
        id={id}
        kind={null}
        title={title}
        icon={icon}
        controls={controls}
        tools={tools}
        link={false}
        assistant={false}
        pad={false}
      >
        {body}
      </LumenWidget>
    ),
  };
}

const pageCardConfig = (ids: [string, number][]) =>
  ids.map(([id, w]) => ({ id, kind: 'page' as const, w, title: null, filter: [] }));

// ---------- Needs attention ----------

function Attention({ m, us, limit = 8 }: { m: Model; us: Usage[]; limit?: number }) {
  const navigate = useNavigate();
  const rows = us
    .filter((u) => SEVERITY[u.st] >= 1)
    .sort((p, q) => SEVERITY[q.st] - SEVERITY[p.st] || q.fpct - p.fpct)
    .slice(0, limit);
  if (!rows.length) return <p className="p-3 text-muted-foreground text-sm">Nothing near a limit.</p>;
  return (
    <div className="flex flex-col">
      {rows.map((u) => {
        const why =
          u.st === 'block'
            ? u.pct >= 1
              ? 'Failing until reset'
              : `Hit ${fmt(u.limit, u.m.unit)}/day on ${dayLabel(m.dates[Number(u.peakDay)] ?? '')}`
            : u.st === 'over'
              ? `Billed ${usd(u.cost)} so far`
              : u.st === 'soon'
                ? u.hard
                  ? `Hard limit by ${monthEnd()}`
                  : `About ${usd(u.fcost)} extra by ${monthEnd()}`
                : `${pctText(u.pct)} used`;
        return (
          <button
            key={`${u.a.id}|${u.m.key}`}
            type="button"
            onClick={() => navigate({ to: '/a/$acct', params: { acct: u.a.id } })}
            className="flex w-full items-center gap-3 border-b border-l-3 px-3 py-2 text-left last:border-b-0 hover:bg-muted/50"
            style={{ borderLeftColor: SEVERITY[u.st] >= 3 ? 'var(--loss)' : 'var(--warning)' }}
          >
            <ColorDot color={u.a.color} />
            <span className="flex min-w-0 flex-1 flex-col">
              <b className="truncate font-semibold text-[13px]">
                {PRODUCT[u.m.product].label} · {u.m.label}
              </b>
              <span className="truncate text-muted-foreground text-xs">
                {u.a.name} · {why}
              </span>
            </span>
            <StatusPill u={u} dates={m.dates} />
          </button>
        );
      })}
    </div>
  );
}

// ---------- Usage chart (metric picker, bars) ----------

const CHART_METRICS = METRICS.filter((x) => x.kind === 'sum').map((x) => ({
  value: x.key,
  label: `${PRODUCT[x.product].label} · ${x.label}`,
}));

function UsageChart({
  m,
  series,
  metric,
}: {
  m: Model;
  series: { name: string; color: string; values: number[] }[];
  metric: string;
}) {
  const met = METRIC[metric];
  if (!series.length || !met)
    return (
      <p className="p-3 text-muted-foreground text-sm">No {met?.label.toLowerCase() ?? 'usage'} here yet.</p>
    );
  return (
    <div className="p-3">
      <DailyColumns
        dates={m.dates}
        series={series}
        unit={met.unit}
        label={`${PRODUCT[met.product].label} ${met.label}, daily`}
      />
    </div>
  );
}

function MetricPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <LumenSelector options={CHART_METRICS} value={value} onChange={onChange} size="sm" align="end" />;
}

// ---------- Overview ----------

const OVERVIEW = view({
  name: 'Overview',
  columns: ['account', 'product', 'metric', 'used', 'pct', 'fpct', 'cost', 'status'],
  cards: pageCardConfig([
    ['attention', 3],
    ['chart', 3],
    ['heat', 3],
    ['accounts', 3],
  ]),
} as Partial<CustomViewConfig> & { name: string });

export function OverviewPage() {
  const m = useModel();
  const navigate = useNavigate();
  const [metric, setMetric] = useState('workers.req');
  const saved = useSavedView('overview', OVERVIEW);
  const domain = useMemo(() => limitDomain(m), [m]);
  if (!m.accounts.length) return <Waiting m={m} crumbs={[{ label: 'Overview' }]} />;
  const as = m.accounts;
  const xs = m.usage;
  const paid = as.filter((a) => a.plan === 'paid');
  const mtd = as.reduce((s, a) => s + accountBill(m, a).mtd, 0);
  const fc = as.reduce((s, a) => s + accountBill(m, a).fc, 0);
  const base = paid.length * 5;
  const day = as[0]?.day ?? 1;
  const cards: LumenLayoutCard[] = [
    pageCard(
      'attention',
      'Needs attention',
      TriangleAlert,
      <Attention m={m} us={xs} limit={6} />,
      <Button size="sm" variant="ghost" asChild>
        <Link to="/limits">All limits</Link>
      </Button>,
    ),
    pageCard(
      'chart',
      `${METRIC[metric]?.label ?? ''} by account`,
      ChartColumn,
      <UsageChart
        m={m}
        metric={metric}
        series={as.flatMap((a) => {
          const u = xs.find((y) => y.a.id === a.id && y.m.key === metric);
          return u ? [{ name: a.name, color: a.color, values: u.days }] : [];
        })}
      />,
      <MetricPicker value={metric} onChange={setMetric} />,
    ),
    pageCard(
      'heat',
      'Limit forecast',
      Gauge,
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="px-3 py-1.5 text-left font-semibold">Category</th>
              {as.map((a) => (
                <th key={a.id} className="px-1 py-1.5 font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    <ColorDot color={a.color} />
                    {a.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <CategoryIcon id={c.id} />
                    {c.label}
                  </span>
                </td>
                {as.map((a) => {
                  const w = worst(xs.filter((u) => u.a.id === a.id && PRODUCT[u.m.product].cat === c.id));
                  if (!w)
                    return (
                      <td key={a.id} className="px-1 py-1 text-center text-muted-foreground">
                        —
                      </td>
                    );
                  const amt = SEVERITY[w.st] >= 1 ? 22 + Math.min(w.fpct, 1.5) * 14 : 6 + w.fpct * 14;
                  return (
                    <td key={a.id} className="p-0.5">
                      <button
                        type="button"
                        title={`${a.name} · ${PRODUCT[w.m.product].label}: ${w.m.label}, forecast ${pctText(w.fpct)}`}
                        onClick={() =>
                          navigate({ to: '/a/$acct', params: { acct: a.id }, search: { cat: c.id } })
                        }
                        className="h-7 w-full min-w-16 rounded-md font-mono font-semibold text-xs"
                        style={{
                          background: `color-mix(in oklab, ${sevColor(w.st)} ${amt.toFixed(0)}%, var(--card))`,
                        }}
                      >
                        {pctText(w.fpct)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    ),
    pageCard(
      'accounts',
      'Accounts',
      Building2,
      <DetailsTable
        head={[
          { label: 'Account', grow: true },
          { label: 'Plan' },
          { label: 'Closest to limit' },
          { label: 'Forecast bill', right: true },
        ]}
        rows={as.map((a) => {
          const w = worst(xs.filter((u) => u.a.id === a.id));
          return {
            key: a.id,
            cells: [
              <Link
                key="n"
                to="/a/$acct"
                params={{ acct: a.id }}
                className="inline-flex items-center gap-2 font-medium hover:underline"
              >
                <ColorDot color={a.color} />
                {a.name}
              </Link>,
              a.plan === 'paid' ? 'Paid' : 'Free',
              w ? (
                <span key="w" className="inline-flex items-center gap-2">
                  <StatusPill u={w} dates={m.dates} />
                  <span className="text-muted-foreground text-xs">
                    {PRODUCT[w.m.product].label} {w.m.label.toLowerCase()}
                  </span>
                </span>
              ) : (
                '—'
              ),
              usd(accountBill(m, a).fc),
            ],
          };
        })}
      />,
    ),
  ];
  return (
    <LumenLayout
      crumbs={[{ label: 'Overview' }]}
      meta={`Billing period ${monthStart()} – ${monthEnd()} · day ${day} of ${as[0]?.monthDays ?? 30}`}
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} />
          <TileRow aria-label="Totals">
            <Tile
              label="Bill so far"
              value={usd(mtd)}
              caption={`${as.length} account${as.length === 1 ? '' : 's'} · ${monthStart()} – today`}
            />
            <Tile
              label="Forecast"
              value={usd(fc)}
              caption={base ? `${usd(fc - base)} over the ${usd(base)} base` : 'Free plans only'}
              valueClassName={fc > base + 0.5 ? 'text-warning' : undefined}
            />
            <Tile
              label="Limits at risk"
              value={xs.filter((u) => SEVERITY[u.st] >= 2).length}
              caption={`${xs.filter((u) => u.st === 'block').length} blocked · ${xs.filter((u) => u.st === 'over').length} billed`}
              valueClassName={xs.some((u) => SEVERITY[u.st] >= 3) ? 'text-loss' : undefined}
            />
            <Tile
              label="Resources"
              value={m.resources.filter((r) => !r.total).length}
              caption={`${m.labels.labels.length} labels`}
            />
          </TileRow>
        </div>
      }
      domain={domain}
      rows={xs}
      load={m.load}
      cards={cards}
      rowTitle={(u) => `${u.a.name} · ${PRODUCT[u.m.product].label} ${u.m.label}`}
      {...saved}
    />
  );
}

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ---------- Limits ----------

const LIMITS = view({
  name: 'Every allowance',
  columns: ['account', 'product', 'metric', 'used', 'allowance', 'pct', 'fpct', 'cost', 'status'],
  group: { fields: ['account', 'category', 'product', 'family', 'status'], default: 'account' },
  sort: { key: 'fpct', desc: true },
  width: 'scroll',
} as Partial<CustomViewConfig> & { name: string });

export function LimitsPage() {
  const m = useModel();
  const saved = useSavedView('limits', LIMITS);
  const domain = useMemo(() => limitDomain(m), [m]);
  if (!m.accounts.length) return <Waiting m={m} crumbs={[{ label: 'Limits' }]} />;
  const xs = m.usage;
  return (
    <LumenLayout
      crumbs={[{ label: 'Limits' }]}
      meta="Paid: month to date · Free: today"
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} />
          <TileRow aria-label="Limits">
            <Tile
              label="Blocked"
              value={xs.filter((u) => u.st === 'block').length}
              caption="Free plan, hit a hard limit"
              valueClassName="text-loss"
            />
            <Tile
              label="Over, billed"
              value={xs.filter((u) => u.st === 'over').length}
              caption="Paid, beyond included"
              valueClassName="text-loss"
            />
            <Tile
              label="Will exceed"
              value={xs.filter((u) => u.st === 'soon').length}
              caption={`Forecast by ${monthEnd()}`}
              valueClassName="text-warning"
            />
            <Tile
              label="Watch"
              value={xs.filter((u) => u.st === 'watch').length}
              caption={`Above ${m.prefs.warn}%`}
            />
          </TileRow>
        </div>
      }
      domain={domain}
      rows={xs}
      load={m.load}
      rowTitle={(u) => `${u.a.name} · ${PRODUCT[u.m.product].label} ${u.m.label}`}
      {...saved}
    />
  );
}

// ---------- Account overview ----------

const ACCOUNT = view({
  name: 'Account',
  columns: ['product', 'metric', 'used', 'allowance', 'pct', 'fpct', 'cost', 'status'],
  cards: pageCardConfig([
    ['plan', 6],
    ['chart', 3],
    ['top', 3],
  ]),
} as Partial<CustomViewConfig> & { name: string });

/** One usage row against its allowance: the meter split by resource, forecast and limit. */
function LimitRow({ u, m, open, onToggle }: { u: Usage; m: Model; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="grid w-full grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40"
    >
      <span className="flex flex-col">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[13px]">
          <ProductIcon id={u.m.product} className="size-3.5" />
          {PRODUCT[u.m.product].label} · {u.m.label}
        </span>
        <small className="text-[11px] text-muted-foreground">
          {u.hard ? 'Hard limit' : 'Included'} {fmt(u.limit, u.m.unit)}
          {perText(u)}
        </small>
      </span>
      <Meter share={u.pct} status={u.st} wide />
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs">
          <b>{fmt(u.used, u.m.unit)}</b>
        </span>
        <StatusPill u={u} dates={m.dates} />
      </span>
      {open && (
        <span className="col-span-2 col-start-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {u.parts.slice(0, 6).map((p, i) => (
            <span key={p.r.id} className="inline-flex items-center gap-1.5">
              <ColorDot color={ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] as string} />
              {p.r.name} <span className="font-mono">{fmt(p.v, u.m.unit)}</span>
            </span>
          ))}
          {u.parts.length > 6 && <span>+{u.parts.length - 6} more</span>}
          <span className="font-mono">
            {u.basis === 'today'
              ? `30-day peak ${fmt(u.peak ?? 0, u.m.unit)}`
              : `Forecast ${fmt(u.forecast, u.m.unit)}`}
          </span>
        </span>
      )}
    </button>
  );
}

export function AccountPage({ acct, cat }: { acct: string; cat?: CategoryId }) {
  const m = useModel();
  const navigate = useNavigate();
  const [metric, setMetric] = useState('workers.req');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const saved = useSavedView('account', ACCOUNT);
  const a = m.account[acct];
  const xs = useMemo(() => m.usage.filter((u) => u.a.id === acct), [m, acct]);
  const domain = useMemo(() => limitDomain(m), [m]);
  if (!a) return <Waiting m={m} crumbs={[{ label: 'Account' }]} />;
  const tab = cat ?? 'all';
  const inTab = xs
    .filter((u) => tab === 'all' || PRODUCT[u.m.product].cat === tab)
    .sort((p, q) => SEVERITY[q.st] - SEVERITY[p.st] || q.fpct - p.fpct);
  const shown = showAll ? inTab : inTab.filter((u) => SEVERITY[u.st] >= 1);
  const rs = m.resources.filter((r) => r.acct === acct);
  const b = accountBill(m, a);
  const cats = CATEGORIES.filter((c) => xs.some((u) => PRODUCT[u.m.product].cat === c.id));
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const ranked = rs
    .filter((r) => r.series[metric])
    .map((r) => ({ r, v: xs.find((u) => u.m.key === metric)?.parts.find((p) => p.r.id === r.id)?.v ?? 0 }))
    .sort((p, q) => q.v - p.v);
  const top5 = ranked.slice(0, 5).map((p, i) => ({
    name: p.r.name,
    color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] as string,
    values: p.r.series[metric] ?? [],
  }));
  if (ranked.length > 5)
    top5.push({
      name: `${ranked.length - 5} more`,
      color: 'var(--chart-8)',
      values: m.dates.map((_, i) => ranked.slice(5).reduce((s, p) => s + (p.r.series[metric]?.[i] ?? 0), 0)),
    });
  const top = rs
    .filter((r) => !r.total && m.info(r).main)
    .sort((p, q) => (m.info(q).main?.share ?? 0) - (m.info(p).main?.share ?? 0))
    .slice(0, 6);

  const cards: LumenLayoutCard[] = [
    pageCard(
      'plan',
      'Usage vs plan',
      Gauge,
      shown.length ? (
        <div className="flex flex-col">
          {shown.map((u) => (
            <LimitRow key={u.m.key} u={u} m={m} open={open.has(u.m.key)} onToggle={() => toggle(u.m.key)} />
          ))}
        </div>
      ) : (
        <p className="p-3 text-muted-foreground text-sm">
          Everything here is under {m.prefs.warn}% of its allowance.
        </p>
      ),
      <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
        {showAll ? 'At risk only' : `Show all ${inTab.length}`}
      </Button>,
    ),
    pageCard(
      'chart',
      `${METRIC[metric]?.label ?? ''} by resource`,
      ChartColumn,
      <UsageChart m={m} series={top5} metric={metric} />,
      <MetricPicker value={metric} onChange={setMetric} />,
    ),
    pageCard(
      'top',
      'Top resources',
      Rows3,
      <DetailsTable
        head={[{ label: 'Name', grow: true }, { label: 'Share of allowance' }]}
        rows={top.map((r) => {
          const x = m.info(r).main;
          return {
            key: r.id,
            cells: [
              <Link
                key="n"
                to="/a/$acct/resources"
                params={{ acct }}
                search={{ open: r.id }}
                className="inline-flex items-center gap-2 font-medium hover:underline"
              >
                <ProductIcon id={r.product} />
                {r.name}
              </Link>,
              x ? (
                <span key="s" className="inline-flex items-center gap-2">
                  <Meter share={x.share} status={x.share >= 1 ? 'over' : x.share >= 0.5 ? 'watch' : 'ok'} />
                  <span className="text-muted-foreground text-xs">{x.u.m.label.toLowerCase()}</span>
                </span>
              ) : (
                '—'
              ),
            ],
          };
        })}
      />,
      <Button size="sm" variant="ghost" asChild>
        <Link to="/a/$acct/resources" params={{ acct }}>
          All {rs.length}
        </Link>
      </Button>,
    ),
  ];

  return (
    <LumenLayout
      crumbs={[{ label: <AccountName a={a} />, name: a.name }, { label: 'Overview' }]}
      meta={
        <>
          {a.plan === 'paid' ? 'Workers Paid' : 'Workers Free'}
          {a.planSource === 'assumed' && ' (assumed; set it in Settings)'}
          {a.planSource === 'inferred' && ' (from its usage)'} ·{' '}
          <span className="font-mono">
            {a.id.slice(0, 6)}…{a.id.slice(-4)}
          </span>{' '}
          · {a.plan === 'paid' ? `Resets ${nextMonth()}` : 'Daily limits reset 00:00 UTC'}
        </>
      }
      actions={
        <Button size="sm" variant="ghost" asChild>
          <a href={`https://dash.cloudflare.com/${a.id}`} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            Cloudflare
          </a>
        </Button>
      }
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} acct={acct} />
          <TileRow aria-label="Account">
            <Tile
              label="Plan"
              value={a.plan === 'paid' ? 'Workers Paid' : 'Free'}
              caption={a.plan === 'paid' ? '$5.00/mo base' : 'Hard daily limits'}
            />
            <Tile
              label="Bill so far"
              value={usd(b.mtd)}
              caption={a.plan === 'paid' ? `${monthStart()} – today, est.` : 'No charges'}
            />
            <Tile
              label="Forecast"
              value={usd(b.fc)}
              caption={a.plan === 'paid' ? `${usd(b.fc - 5)} beyond base` : '—'}
              valueClassName={b.fc > 5.5 ? 'text-warning' : undefined}
            />
            <Tile
              label="Limits at risk"
              value={xs.filter((u) => SEVERITY[u.st] >= 2).length}
              caption={`of ${xs.length} tracked`}
              valueClassName={xs.some((u) => SEVERITY[u.st] >= 3) ? 'text-loss' : undefined}
            />
          </TileRow>
          <TileToggleGroup
            label="Category"
            selected={tab}
            onSelect={(id) =>
              navigate({
                to: '/a/$acct',
                params: { acct },
                search: id === 'all' ? {} : { cat: id as CategoryId },
              })
            }
            options={[
              {
                id: 'all',
                label: 'All products',
                value: `${xs.filter((u) => SEVERITY[u.st] >= 2).length} at risk`,
              },
              ...cats.map((c) => {
                const w = worst(xs.filter((u) => PRODUCT[u.m.product].cat === c.id));
                return {
                  id: c.id,
                  label: c.label,
                  value: <span className={w ? sevClass(w.st) : ''}>{w ? pctText(w.fpct) : '—'}</span>,
                };
              }),
            ]}
          />
        </div>
      }
      domain={domain}
      rows={xs}
      load={m.load}
      cards={cards}
      rowTitle={(u) => `${PRODUCT[u.m.product].label} ${u.m.label}`}
      {...saved}
    />
  );
}

function nextMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function AccountName({ a }: { a: AccountView }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <ColorDot color={a.color} />
      {a.name}
    </span>
  );
}

// ---------- Resources ----------

const RES_COLUMNS = ['name', 'account', 'product', 'label', 'used', 'share', 'trend', 'cost'];
const RESOURCES = view({
  name: 'Resources',
  columns: RES_COLUMNS,
  group: { fields: ['account', 'category', 'product', 'type', 'label'], default: null },
  sort: { key: 'share', desc: true },
  width: 'scroll',
} as Partial<CustomViewConfig> & { name: string });

export function ResourcesPage({ acct, label, open }: { acct?: string; label?: string; open?: string }) {
  const m = useModel();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | CategoryId>('all');
  // The table can hold on to an older `selection` between renders, so its keys are one Set kept
  // current in place, and every change goes through one stable setter.
  const selKeys = useRef(new Set<string>()).current;
  const [, bump] = useState(0);
  const setSel = useRef((next: Set<string>) => {
    if (next !== selKeys) {
      selKeys.clear();
      for (const k of next) selKeys.add(k);
    }
    bump((n) => n + 1);
  }).current;
  const selection = useRef({ keys: selKeys, onChange: setSel }).current;
  const sel = selKeys;
  // Each category tab is its own table (its metric-family columns), saved apart from All.
  const tabDefault = useMemo(() => {
    if (tab === 'all') return RESOURCES;
    const fams = FAMILIES.filter((f) =>
      m.resources.some(
        (r) =>
          PRODUCT[r.product].cat === tab && Object.keys(r.series).some((k) => METRIC[k]?.family === f.id),
      ),
    );
    return { ...RESOURCES, columns: [...RES_COLUMNS.slice(0, 4), ...fams.map((f) => `fam_${f.id}`), 'cost'] };
  }, [tab, m.resources]);
  const saved = useSavedView(tab === 'all' ? 'resources' : `resources-${tab}`, tabDefault);
  const openRes = (id: string | undefined) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, open: id }), replace: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: openRes only navigates.
  const domain = useMemo(() => resourceDomain(m, openRes), [m]);
  const current = open ? m.resource[open] : undefined;
  // The drawer keeps showing the last resource while it slides shut.
  const last = useRef(current);
  if (current) last.current = current;
  const drawer = last.current;
  const a = acct ? m.account[acct] : undefined;
  const scoped = m.resources.filter(
    (r) => !r.total && (!acct || r.acct === acct) && (!label || m.labelsOf(r).includes(label)),
  );
  const rows = scoped.filter((r) => tab === 'all' || PRODUCT[r.product].cat === tab);
  if (!m.accounts.length) return <Waiting m={m} crumbs={[{ label: 'Resources' }]} />;

  const columns = saved.config.columns.filter((c) => !(acct && c === 'account'));
  const config: CustomViewConfig = {
    ...saved.config,
    columns,
    filters: { ...saved.config.filters, default: label ? [{ key: 'label', value: label }] : [] },
  };
  const counts = (id: 'all' | CategoryId) =>
    scoped.filter((r) => id === 'all' || PRODUCT[r.product].cat === id).length;
  const crumbs = [
    ...(a
      ? [
          { label: <AccountName a={a} />, name: a.name, to: `/a/${a.id}` },
          { label: 'Resources', to: label ? `/a/${a.id}/resources` : undefined },
        ]
      : [{ label: 'All resources', to: label ? '/resources' : undefined }]),
    ...(label ? [{ label: <LabelMark m={m} name={label} withName />, name: label }] : []),
  ];
  const cost = rows.reduce((s, r) => s + m.info(r).cost, 0);
  const fcost = rows.reduce((s, r) => s + m.info(r).fcost, 0);
  return (
    <>
      <LumenLayout
        key={`${acct ?? ''}|${label ?? ''}|${tab}`}
        crumbs={crumbs}
        meta={label ? 'Everything with this label' : 'Main metric month to date, today on Free'}
        intro={
          <div className="flex flex-col gap-3">
            {label && (
              <TileRow aria-label="Label">
                <Tile
                  label="Resources"
                  value={rows.length}
                  caption={`${new Set(rows.map((r) => r.product)).size} products`}
                />
                {!acct && (
                  <Tile
                    label="Accounts"
                    value={new Set(rows.map((r) => r.acct)).size}
                    caption={[...new Set(rows.map((r) => m.account[r.acct]?.name))].join(' · ')}
                  />
                )}
                <Tile label="Cost so far" value={usd(cost)} caption="Its share of usage beyond plan" />
                <Tile
                  label="Forecast cost"
                  value={usd(fcost)}
                  caption={`By ${monthEnd()}`}
                  valueClassName={fcost > 0.5 ? 'text-warning' : undefined}
                />
              </TileRow>
            )}
            <LumenTabs
              value={tab}
              onChange={(v) => setTab(v as typeof tab)}
              tabs={[
                {
                  value: 'all',
                  label: 'All',
                  icon: Rows3,
                  after: (
                    <span className="ml-1 font-mono text-muted-foreground text-xs">{counts('all')}</span>
                  ),
                },
                ...CATEGORIES.filter((c) => counts(c.id)).map((c) => ({
                  value: c.id,
                  label: c.label,
                  icon: CATEGORY_ICON[c.id],
                  after: <span className="ml-1 font-mono text-muted-foreground text-xs">{counts(c.id)}</span>,
                })),
              ]}
            />
          </div>
        }
        domain={domain}
        rows={rows}
        load={m.load}
        config={config}
        onConfigChange={saved.onConfigChange}
        onReset={saved.onReset}
        selection={selection}
        rowTitle={(r) => r.name}
        onOpen={(r) => openRes(r.id)}
        actions={
          label ? (
            <LabelForm
              m={m}
              edit={label}
              onDone={(n) => n !== label && navigate({ to: '.', search: { label: n } })}
            >
              <Button size="sm" variant="ghost">
                <Palette className="size-4" />
                Edit label
              </Button>
            </LabelForm>
          ) : undefined
        }
      />
      <BulkBar m={m} ids={[...sel]} shown={rows.map((r) => r.id)} onSelect={setSel} />
      <LumenDrawer
        open={!!current}
        onClose={() => openRes(undefined)}
        title={
          drawer ? (
            <span className="inline-flex items-center gap-2">
              <ProductIcon id={drawer.product} />
              {drawer.name}
            </span>
          ) : (
            ''
          )
        }
        description={
          drawer
            ? `${m.account[drawer.acct]?.name ?? ''} · ${PRODUCT[drawer.product].label}${drawer.routes?.length ? ` · ${drawer.routes.join(', ')}` : ''}`
            : undefined
        }
      >
        {drawer &&
          domain.details?.map((d) => (
            <DrawerSection
              key={d.id}
              icon={d.icon}
              title={d.label}
              count={d.count?.(drawer) ?? null}
              defaultOpen={typeof d.open === 'function' ? d.open(drawer) : d.open}
            >
              {d.render(drawer)}
            </DrawerSection>
          ))}
      </LumenDrawer>
    </>
  );
}

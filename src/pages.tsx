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
  KIT,
  LumenDrawer,
  LumenLayout,
  type LumenLayoutCard,
  LumenTabs,
  LumenWidget,
  meterLevel,
  meterValueTone,
  NoteLine,
  ShareMeter,
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
  PRODUCT,
  type ProductId,
  permissionsFor,
  type Resource,
} from '../shared/catalog';
import { limitDomain, resourceDomain, UsageLines, view } from './domains';
import { BulkBar, LabelForm, LabelMark } from './labels';
import { AccountMetersCard, PlanMeter, planText, Trend7, UsageCell, WatchChip, WatchFor } from './meters';
import {
  type AccountView,
  fmt,
  type Model,
  monthEnd,
  pctText,
  sevColor,
  statusText,
  type Usage,
  usd,
  useModel,
} from './model';
import { CATEGORY_ICON, ProductIcon } from './products';

// ---------- Saved page layouts ----------

type PageId =
  | 'overview'
  | 'overview-usage'
  | 'account'
  | 'account-usage'
  | 'limits'
  | 'resources'
  | 'resources-all'
  | `resources-${CategoryId}`;

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

/** One day's use as a share of that day's allowance (a month's split evenly; a size against the
 *  whole allowance); 0 where nothing is included. */
const _dayShare = (u: Usage, v: number) =>
  u.payg || !u.limit ? 0 : v / (u.m.kind === 'gauge' || u.per === 'day' ? u.limit : u.limit / 30);

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

// ---------- Usage chart (metric picker, bars) ----------

// ---------- Overview ----------

const OVERVIEW = view({
  name: 'Overview',
  columns: ['account', 'product', 'metric', 'used', 'pct', 'fpct', 'cost', 'status'],
  cards: pageCardConfig([
    ['accounts', 6],
    ['watch', 3],
    ['usage', 3],
    ['top', 6],
  ]),
} as Partial<CustomViewConfig> & { name: string });

/** A share's text colour on the kit's meter levels: none while there is room. */
const toneText = (share: number) => {
  const t = meterValueTone(share);
  return t === 'loss' ? 'text-loss' : t === 'warning' ? 'text-warning' : '';
};

/** Meters at or past the kit's watch level, closest to their cap first: one line each. */
function WatchList({
  m,
  us,
  limit,
  showAccount,
  all,
}: {
  m: Model;
  us: Usage[];
  limit: number;
  showAccount?: boolean;
  /** Every meter, not only those at the watch level. */
  all?: boolean;
}) {
  const rows = us
    .filter((u) => all || (!u.payg && meterLevel(u.pct) !== 'ok'))
    .sort((p, q) => Number(p.payg) - Number(q.payg) || q.pct - p.pct)
    .slice(0, limit);
  if (!rows.length)
    return (
      <p className="p-3 text-muted-foreground text-sm">Every meter is under {m.prefs.warn}% of its cap.</p>
    );
  return (
    <DetailsTable
      head={[
        { label: 'Meter', grow: true },
        { label: 'Used', right: true, hideOnPhone: true },
        { label: 'Of cap' },
        // Half-width on Overview: the status moves into the name's tooltip.
        ...(showAccount ? [] : [{ label: 'Status', hideOnPhone: true }]),
      ]}
      rows={rows.map((u) => ({
        key: `${u.a.id}:${u.m.key}`,
        cells: [
          <span
            key="n"
            className="inline-flex min-w-0 items-center gap-2"
            title={`${u.a.name} · ${PRODUCT[u.m.product].label} ${u.m.label} · ${statusText(u, m.dates)}`}
          >
            {showAccount && <ColorDot color={u.a.color} />}
            <ProductIcon id={u.m.product} />
            <span className="truncate max-md:max-w-52">
              {PRODUCT[u.m.product].label} {u.m.label}
            </span>
          </span>,
          <span key="v" className="num whitespace-nowrap">
            {fmt(u.used, u.m.unit)}
          </span>,
          u.payg ? (
            <span key="s" className="text-muted-foreground text-xs">
              Pay as you go
            </span>
          ) : (
            <span key="s">
              <ShareMeter className="max-md:hidden" value={u.pct} label={pctText(u.pct)} />
              <span className={`num md:hidden ${toneText(u.pct)}`}>{pctText(u.pct)}</span>
            </span>
          ),
          ...(showAccount ? [] : [<StatusPill key="p" u={u} dates={m.dates} />]),
        ],
      }))}
    />
  );
}

/** The resources using the most of their allotment: Usage, Watch for and Trend 7d, one line each. */
function TopResources({
  m,
  rs,
  limit,
  showAccount,
}: {
  m: Model;
  rs: Resource[];
  limit: number;
  showAccount?: boolean;
}) {
  const top = rs
    .filter((r) => !r.total && m.info(r).main)
    .sort((p, q) => m.info(q).plan - m.info(p).plan)
    .slice(0, limit);
  return (
    <DetailsTable
      head={[
        { label: 'Name', grow: true },
        { label: showAccount ? 'Account' : 'Product', hideOnPhone: true },
        { label: 'Usage' },
        { label: 'Watch for' },
        { label: 'Trend 7d', right: true, hideOnPhone: true },
      ]}
      rows={top.map((r) => {
        const a = m.account[r.acct];
        return {
          key: r.id,
          cells: [
            <Link
              key="n"
              to="/a/$acct/resources"
              params={{ acct: r.acct }}
              search={{ open: r.id }}
              className="inline-flex min-w-0 items-center gap-2 font-medium hover:underline"
            >
              <ProductIcon id={r.product} />
              <span className="truncate max-md:max-w-28">{r.name}</span>
            </Link>,
            showAccount ? (
              <span key="a" className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <ColorDot color={a?.color ?? 'var(--muted-foreground)'} />
                {a?.name}
              </span>
            ) : (
              <span key="p" className="whitespace-nowrap">
                {PRODUCT[r.product].label}
              </span>
            ),
            <UsageCell key="u" model={m} r={r} />,
            <WatchFor key="w" model={m} r={r} />,
            <Trend7 key="t" t={m.info(r).trend} />,
          ],
        };
      })}
    />
  );
}

export function OverviewPage() {
  const m = useModel();
  const saved = useSavedView('overview-usage', OVERVIEW);
  const domain = useMemo(() => limitDomain(m), [m]);
  if (!m.accounts.length) return <Waiting m={m} crumbs={[{ label: 'Overview' }]} />;
  const as = m.accounts;
  const xs = m.usage;
  const paid = as.filter((a) => a.plan === 'paid');
  const mtd = as.reduce((s, a) => s + accountBill(m, a).mtd, 0);
  const fc = as.reduce((s, a) => s + accountBill(m, a).fc, 0);
  const base = paid.length * 5;
  const day = as[0]?.day ?? 1;
  const watching = xs.filter((u) => !u.payg && meterLevel(u.pct) !== 'ok');
  const alerts = watching.filter((u) => meterLevel(u.pct) === 'alert');
  const resources = m.resources.filter((r) => !r.total);
  const cards: LumenLayoutCard[] = [
    pageCard(
      'accounts',
      'Accounts',
      Building2,
      <DetailsTable
        head={[
          { label: 'Account', grow: true },
          { label: 'Plan', hideOnPhone: true },
          { label: 'Usage' },
          { label: 'Watch for' },
          { label: 'Trend 7d', right: true, hideOnPhone: true },
          { label: 'Forecast bill', right: true, hideOnPhone: true },
        ]}
        rows={as.map((a) => {
          const p = m.plan(a);
          const us = xs.filter((u) => u.a.id === a.id);
          return {
            key: a.id,
            cells: [
              <Link
                key="n"
                to="/a/$acct"
                params={{ acct: a.id }}
                className="inline-flex min-w-0 items-center gap-2 font-medium hover:underline"
              >
                <ColorDot color={a.color} />
                <span className="truncate max-md:max-w-32">{a.name}</span>
              </Link>,
              a.plan === 'paid' ? 'Paid' : 'Free',
              <AccountMetersCard key="u" title={a.name} us={us}>
                <PlanMeter share={p.share} />
              </AccountMetersCard>,
              p.watch ? (
                <AccountMetersCard key="w" title={a.name} us={us} hl={p.watch.m.key}>
                  <WatchChip
                    label={`${PRODUCT[p.watch.m.product].label} ${p.watch.m.label}`}
                    share={p.watch.pct}
                  />
                </AccountMetersCard>
              ) : (
                '—'
              ),
              <Trend7 key="t" t={p.trend} />,
              <span key="b" className="num">
                {usd(accountBill(m, a).fc)}
              </span>,
            ],
          };
        })}
      />,
    ),
    pageCard(
      'watch',
      'Watch for',
      TriangleAlert,
      <WatchList m={m} us={xs} limit={6} showAccount />,
      <Button size="sm" variant="ghost" asChild>
        <Link to="/limits">All limits</Link>
      </Button>,
    ),
    pageCard(
      'usage',
      'Usage this month',
      ChartColumn,
      <div className="p-3">
        <UsageLines
          dates={m.dates}
          series={as.map((a) => ({ name: a.name, color: a.color, values: m.plan(a).days }))}
        />
      </div>,
    ),
    pageCard(
      'top',
      'Top resources',
      Rows3,
      <TopResources m={m} rs={resources} limit={8} showAccount />,
      <Button size="sm" variant="ghost" asChild>
        <Link to="/resources">All {resources.length}</Link>
      </Button>,
    ),
  ];
  return (
    <LumenLayout
      crumbs={[{ label: 'Overview' }]}
      meta={`Billing period ${monthStart()} – ${monthEnd()} · day ${day} of ${as[0]?.monthDays ?? 30}`}
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} />
          <TileRow fill aria-label="Totals">
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
              label="Watch for"
              value={watching.length}
              caption={`${alerts.length} at ${Math.round(KIT.meterLevels.alert * 100)}% or more`}
              valueClassName={alerts.length ? 'text-loss' : watching.length ? 'text-warning' : undefined}
            />
            <Tile label="Resources" value={resources.length} caption={`${m.labels.labels.length} labels`} />
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
    ['watch', 6],
    ['usage', 3],
    ['top', 3],
  ]),
} as Partial<CustomViewConfig> & { name: string });

export function AccountPage({ acct, cat }: { acct: string; cat?: CategoryId }) {
  const m = useModel();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const saved = useSavedView('account-usage', ACCOUNT);
  const a = m.account[acct];
  const xs = useMemo(() => m.usage.filter((u) => u.a.id === acct), [m, acct]);
  const domain = useMemo(() => limitDomain(m), [m]);
  if (!a) return <Waiting m={m} crumbs={[{ label: 'Account' }]} />;
  const tab = cat ?? 'all';
  const inCat = (u: Usage) => tab === 'all' || PRODUCT[u.m.product].cat === tab;
  const inTab = xs.filter(inCat);
  const rs = m.resources.filter((r) => r.acct === acct && (tab === 'all' || PRODUCT[r.product].cat === tab));
  const b = accountBill(m, a);
  const p = m.plan(a);
  const cats = CATEGORIES.filter((c) => xs.some((u) => PRODUCT[u.m.product].cat === c.id));
  const watching = inTab.filter((u) => !u.payg && meterLevel(u.pct) !== 'ok').length;

  const cards: LumenLayoutCard[] = [
    pageCard(
      'watch',
      showAll ? 'Every meter' : 'Watch for',
      Gauge,
      <WatchList m={m} us={inTab} limit={showAll ? inTab.length : 12} all={showAll} />,
      <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
        {showAll ? `Watch for only (${watching})` : `Show all ${inTab.length}`}
      </Button>,
    ),
    pageCard(
      'usage',
      'Usage this month',
      ChartColumn,
      <div className="p-3">
        <UsageLines
          dates={m.dates}
          series={(tab === 'all' ? cats : cats.filter((c) => c.id === tab)).map((c) => ({
            name: c.label,
            color: c.color,
            values: m.plan(a, (u) => PRODUCT[u.m.product].cat === c.id).days,
          }))}
        />
      </div>,
    ),
    pageCard(
      'top',
      'Top resources',
      Rows3,
      <TopResources m={m} rs={rs} limit={8} />,
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
          <TileRow fill aria-label="Account">
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
              label="Usage"
              value={planText(p.share)}
              caption={
                p.watch
                  ? `Watch for ${PRODUCT[p.watch.m.product].label} ${p.watch.m.label}`
                  : 'of the allotment'
              }
              spark={p.days.filter((v): v is number => v !== null)}
            />
          </TileRow>
          <TileToggleGroup
            fill
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
                value: planText(p.share),
                spark: p.days.filter((v): v is number => v !== null),
              },
              ...cats.map((c) => {
                const cp = m.plan(a, (u) => PRODUCT[u.m.product].cat === c.id);
                return {
                  id: c.id,
                  label: c.label,
                  value: planText(cp.share),
                  spark: cp.days.filter((v): v is number => v !== null),
                  sparkColor: c.color,
                };
              }),
            ]}
          />
        </div>
      }
      domain={domain}
      rows={inTab}
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

const RES_COLUMNS = ['name', 'account', 'product', 'label', 'usage', 'watch', 'trend7', 'cost'];
const RESOURCES = view({
  name: 'Resources',
  columns: RES_COLUMNS,
  group: { fields: ['account', 'category', 'product', 'type', 'label'], default: null },
  sort: { key: 'usage', desc: true },
  width: 'scroll',
} as Partial<CustomViewConfig> & { name: string });

export function ResourcesPage({
  acct,
  label,
  open,
  product,
}: {
  acct?: string;
  label?: string;
  open?: string;
  /** A product link: its category tab, with a Product chip in the filter. */
  product?: ProductId;
}) {
  const m = useModel();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | CategoryId>(product ? PRODUCT[product].cat : 'all');
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
  const saved = useSavedView(tab === 'all' ? 'resources-all' : `resources-${tab}`, tabDefault);
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
    filters: {
      ...saved.config.filters,
      default: [
        ...(label ? [{ key: 'label', value: label }] : []),
        ...(product && (tab === 'all' || PRODUCT[product].cat === tab)
          ? [{ key: 'product', value: PRODUCT[product].label }]
          : []),
      ],
    },
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
        key={`${acct ?? ''}|${label ?? ''}|${product ?? ''}|${tab}`}
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

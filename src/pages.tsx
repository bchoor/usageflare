/**
 * The pages: Overview, Resources (every account, one account, or one tag) and an
 * account's Overview and Limits. Each is a LumenLayout: its cards, widths and table settings are a saved view
 * (Edit layout), kept per page in the Worker's KV.
 */
import {
  apiJson,
  ColorDot,
  DetailsTable,
  DrawerSection,
  durationText,
  type FilterToken,
  KIT,
  LumenDrawer,
  LumenLayout,
  type LumenLayoutCard,
  LumenTabs,
  LumenWidget,
  meterLevel,
  meterValueTone,
  NoteLine,
  type PaceWindow,
  PaceWindowPicker,
  ShareMeter,
  Tile,
  TileRow,
  TileToggleGroup,
  useIsMobile,
  usePaceWindow,
  useShell,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { type CustomViewConfig, domainTiles, type ViewCard } from '@columenlabs/lumen-ui-types/views';
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
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
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
import {
  AccountMetersCard,
  BilledCell,
  PlanMeter,
  planText,
  Trend7,
  UsageCell,
  WatchChip,
  WatchFor,
} from './meters';
import {
  type AccountView,
  billCheck,
  fmt,
  type Model,
  monthEnd,
  pctText,
  sevColor,
  statusText,
  tagNames,
  type Usage,
  usd,
  useModel,
} from './model';
import { hitting, PaceList } from './pace';
import { CATEGORY_ICON, ProductIcon } from './products';
import { meterName, quotaDomain, quotaRows } from './quotas';
import { MoveToCloudflare, stayShort, TagBulkBar, tagAccessLine, tagDomain, tagRows } from './tag-manager';
import { BulkBar, TagForm, TagMark } from './tags';

// ---------- Saved page layouts ----------

type PageId =
  | 'overview'
  | 'overview-usage'
  | 'account'
  | 'account-usage'
  | 'limits'
  | 'account-limits'
  | 'resources'
  | 'resources-all'
  | `resources-${CategoryId}`
  | 'tags'
  | 'account-tags';

/**
 * A page's numbers live in a Row of numbers card of built-in tiles (`usageTile`). A layout saved
 * before that had no tiles: it gets the default ones and the card on top, once. Once saved, its
 * `tiles` are set, so a card the person removes stays removed.
 */
function withNumbers(c: CustomViewConfig, fallback: CustomViewConfig): CustomViewConfig {
  if (c.tiles?.length || !fallback.tiles?.length || !c.cards) return c;
  const ids = new Set(c.cards.map((x) => x.id));
  const id = ['tiles', 'numbers', 'numbers_1', 'numbers_2'].find((x) => !ids.has(x));
  if (!id) return { ...c, tiles: fallback.tiles };
  return { ...c, tiles: fallback.tiles, cards: [{ ...NUMBERS, id, x: 0, y: 0 }, ...c.cards] };
}

/**
 * Pace came after many layouts were saved. A layout from before it (its table has no Hits limit
 * column, shown or hidden) gets the column after Watch for (or Forecast) and its page's On pace
 * card, once; saved again, it has the column, so a card the person removes later stays removed.
 */
function withPace(c: CustomViewConfig, fallback: CustomViewConfig): CustomViewConfig {
  const cols = c.columns ?? [];
  if (!fallback.columns?.includes('pace') || cols.includes('pace') || c.hidden?.includes('pace')) return c;
  const after = ['watch', 'fpct'].map((k) => cols.indexOf(k)).find((i) => i >= 0);
  const at = after === undefined ? cols.length : after + 1;
  const card = fallback.cards?.find((x) => x.id === 'pace');
  const tile = fallback.tiles?.find((t) => 'key' in t && t.key === 'pace');
  const hasTile = c.tiles?.some((t) => 'key' in t && t.key === 'pace');
  return {
    ...c,
    columns: [...cols.slice(0, at), 'pace', ...cols.slice(at)],
    cards: card && c.cards && !c.cards.some((x) => x.id === 'pace') ? [...c.cards, card] : c.cards,
    tiles: tile && c.tiles?.length && !hasTile ? [...c.tiles, tile] : c.tiles,
  };
}

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
    config: saved.data?.config ? withPace(withNumbers(saved.data.config, fallback), fallback) : fallback,
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

/** The Row of numbers on top of a page: the view's own tiles, header off. */
const NUMBERS: ViewCard = { id: 'tiles', kind: 'metric', style: 'row', title: null, w: 6, filter: [] };

/**
 * Draws a built-in tile over the rows its Row of numbers shows, so a card narrowed to one product
 * or account reads only those. An account's $5 base counts only while every meter of it is shown.
 */
function usageTile(m: Model, w: PaceWindow) {
  return (key: string, rows: Usage[]): ReactNode => {
    const shown = new Set(rows);
    const as = m.accounts.filter((a) => rows.some((u) => u.a.id === a.id));
    const whole = (a: AccountView) => m.usage.every((u) => u.a.id !== a.id || shown.has(u));
    const based = as.filter((a) => a.plan === 'paid' && whole(a));
    const one = as.length === 1 ? as[0] : undefined;
    const base = based.length * 5;
    switch (key) {
      case 'bill': {
        const mtd =
          based.reduce((s, a) => s + (5 * a.day) / a.monthDays, 0) + rows.reduce((s, u) => s + u.cost, 0);
        // What Cloudflare billed for the same products, where a token has Billing Read.
        const products = new Set(rows.map((u) => u.m.product));
        const checks = as.flatMap((a) => {
          const c = billCheck(m.usage, a, (p) => (p ? products.has(p) : whole(a)));
          return c ? [c] : [];
        });
        const billed = checks.reduce((s, c) => s + c.billed, 0);
        const est = checks.every((c) => c.est !== null) ? checks.reduce((s, c) => s + (c.est ?? 0), 0) : null;
        return (
          <Tile
            label="Bill so far"
            value={usd(mtd)}
            caption={
              checks.length
                ? `Usage billed ${usd(billed)}${est === null ? '' : ` · est. ${usd(est)}`}`
                : !one
                  ? `${as.length} accounts · ${monthStart()} – today`
                  : one.plan === 'paid'
                    ? `${monthStart()} – today, est.`
                    : 'No charges'
            }
          />
        );
      }
      case 'forecast': {
        const fc = base + rows.reduce((s, u) => s + u.fcost, 0);
        return (
          <Tile
            label="Forecast"
            value={usd(fc)}
            caption={
              base
                ? `${usd(fc - base)} over the ${usd(base)} base`
                : as.some((a) => a.plan === 'paid')
                  ? 'Beyond the base'
                  : 'Free plans only'
            }
            valueClassName={fc > base + 0.5 ? 'text-warning' : undefined}
          />
        );
      }
      case 'watch': {
        const watching = rows.filter((u) => !u.payg && meterLevel(u.pct) !== 'ok');
        const alerts = watching.filter((u) => meterLevel(u.pct) === 'alert');
        return (
          <Tile
            label="Watch for"
            value={watching.length}
            caption={`${alerts.length} at ${Math.round(KIT.meterLevels.alert * 100)}% or more`}
            valueClassName={alerts.length ? 'text-loss' : watching.length ? 'text-warning' : undefined}
          />
        );
      }
      case 'resources': {
        const products = new Set(rows.map((u) => u.m.product));
        const n = m.resources.filter(
          (r) => !r.total && !m.archived(r) && products.has(r.product) && as.some((a) => a.id === r.acct),
        ).length;
        return (
          <Tile
            label="Resources"
            value={n}
            caption={`${
              tagNames(
                m.tags,
                as.map((a) => a.id),
              ).length
            } tags`}
          />
        );
      }
      case 'plan': {
        if (one)
          return (
            <Tile
              label="Plan"
              value={one.plan === 'paid' ? 'Workers Paid' : 'Free'}
              caption={one.plan === 'paid' ? '$5.00/mo base' : 'Hard daily limits'}
            />
          );
        const paid = as.filter((a) => a.plan === 'paid').length;
        return <Tile label="Plan" value={`${paid} paid`} caption={`${as.length - paid} on Free`} />;
      }
      case 'usage': {
        const ps = as.map((a) => ({ a, p: m.plan(a, (u) => shown.has(u)) }));
        const top = ps.reduce<(typeof ps)[number] | undefined>(
          (b, x) => (!b || x.p.share > b.p.share ? x : b),
          undefined,
        );
        if (!top) return <Tile label="Usage" value="—" caption="No meters" />;
        const w = top.p.watch;
        return (
          <Tile
            label="Usage"
            value={planText(top.p.share)}
            caption={
              !one
                ? `Highest: ${top.a.name}`
                : w
                  ? `Watch for ${PRODUCT[w.m.product].label} ${w.m.label}`
                  : 'of the allotment'
            }
            spark={top.p.days.filter((v): v is number => v !== null)}
          />
        );
      }
      case 'pace': {
        const hits = hitting(rows, w);
        const first = hits[0];
        return (
          <Tile
            label="Hits a cap soon"
            value={hits.length}
            caption={
              first ? `First in ${durationText(first.p.eta)} · ${first.u.m.label}` : `At the ${w} pace`
            }
            valueClassName={hits.length ? 'text-warning' : undefined}
          />
        );
      }
      default:
        return null;
    }
  };
}

// ---------- Needs attention ----------

// ---------- Usage chart (metric picker, bars) ----------

// ---------- Overview ----------

const OVERVIEW = view({
  name: 'Overview',
  columns: ['account', 'product', 'metric', 'used', 'pct', 'fpct', 'pace', 'cost', 'status'],
  tiles: domainTiles('bill', 'forecast', 'watch', 'pace', 'resources'),
  cards: [
    NUMBERS,
    ...pageCardConfig([
      ['accounts', 6],
      ['watch', 3],
      ['pace', 3],
      ['usage', 6],
      ['top', 6],
    ]),
  ],
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
            <Trend7 key="t" change={m.info(r).change} unit={m.info(r).main?.u.m.unit} />,
          ],
        };
      })}
    />
  );
}

export function OverviewPage() {
  const m = useModel();
  const [w] = usePaceWindow();
  const saved = useSavedView('overview-usage', OVERVIEW);
  const domain = useMemo(() => limitDomain(m, w), [m, w]);
  if (!m.accounts.length) return <Waiting m={m} crumbs={[{ label: 'Overview' }]} />;
  const as = m.accounts;
  const xs = m.usage;
  const day = as[0]?.day ?? 1;
  const resources = m.resources.filter((r) => !r.total && !m.archived(r));
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
          { label: 'Billed', right: true, hideOnPhone: true },
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
              <Trend7 key="t" change={p.change} />,
              <span key="b" className="num">
                {usd(accountBill(m, a).fc)}
              </span>,
              <BilledCell key="bd" model={m} a={a} />,
            ],
          };
        })}
      />,
    ),
    pageCard('watch', 'Watch for', TriangleAlert, <WatchList m={m} us={xs} limit={6} showAccount />),
    pageCard('pace', 'On pace to hit a cap', Timer, <PaceList us={xs} w={w} limit={6} showAccount />),
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
      actions={<PaceWindowPicker />}
      intro={<Problems m={m} />}
      domain={domain}
      rows={xs}
      load={m.load}
      cards={cards}
      tile={usageTile(m, w)}
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
  name: 'By tag',
  columns: ['tag', 'used', 'quota', 'pct', 'fpct', 'pace', 'cost', 'top'],
  group: { fields: ['product', 'tag', 'status'], default: 'product' },
  subgroup: 'meter',
  sort: { key: 'pct', desc: true },
} as Partial<CustomViewConfig> & { name: string });

/**
 * An account's Limits: each pooled meter by the tags that use it. Quotas are the account's, so
 * this page is per account only.
 */
export function AccountLimitsPage({ acct }: { acct: string }) {
  const m = useModel();
  const [w] = usePaceWindow();
  const saved = useSavedView('account-limits', LIMITS);
  const a = m.account[acct];
  const xs = useMemo(() => m.usage.filter((u) => u.a.id === acct), [m, acct]);
  const rows = useMemo(() => quotaRows(m, xs), [m, xs]);
  const domain = useMemo(() => quotaDomain(m, w), [m, w]);
  if (!a) return <Waiting m={m} crumbs={[{ label: 'Limits' }]} />;
  return (
    <LumenLayout
      crumbs={[{ label: <AccountName a={a} />, name: a.name }, { label: 'Limits' }]}
      meta={a.plan === 'paid' ? `Month to date · resets ${nextMonth()}` : 'Today · resets 00:00 UTC'}
      actions={<PaceWindowPicker />}
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} acct={acct} />
          <TileRow fill aria-label="Limits">
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
      rows={rows}
      load={m.load}
      rowTitle={(q) => `${q.tag} · ${meterName(q.u)}`}
      {...saved}
    />
  );
}

// ---------- Account overview ----------

const ACCOUNT = view({
  name: 'Account',
  columns: ['product', 'metric', 'used', 'allowance', 'pct', 'fpct', 'pace', 'cost', 'status'],
  tiles: domainTiles('plan', 'bill', 'forecast', 'usage', 'pace'),
  cards: [
    NUMBERS,
    ...pageCardConfig([
      ['watch', 3],
      ['pace', 3],
      ['usage', 3],
      ['top', 3],
    ]),
  ],
} as Partial<CustomViewConfig> & { name: string });

export function AccountPage({ acct, cat }: { acct: string; cat?: CategoryId }) {
  const m = useModel();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [w] = usePaceWindow();
  const saved = useSavedView('account-usage', ACCOUNT);
  const a = m.account[acct];
  const xs = useMemo(() => m.usage.filter((u) => u.a.id === acct), [m, acct]);
  const domain = useMemo(() => limitDomain(m, w), [m, w]);
  if (!a) return <Waiting m={m} crumbs={[{ label: 'Account' }]} />;
  const tab = cat ?? 'all';
  const inCat = (u: Usage) => tab === 'all' || PRODUCT[u.m.product].cat === tab;
  const inTab = xs.filter(inCat);
  const rs = m.resources.filter((r) => r.acct === acct && (tab === 'all' || PRODUCT[r.product].cat === tab));
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
    pageCard('pace', 'On pace to hit a cap', Timer, <PaceList us={inTab} w={w} limit={8} />),
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
        <>
          <PaceWindowPicker />
          <Button size="sm" variant="ghost" asChild>
            <a href={`https://dash.cloudflare.com/${a.id}`} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Cloudflare
            </a>
          </Button>
        </>
      }
      intro={
        <div className="flex flex-col gap-3">
          <Problems m={m} acct={acct} />
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
      tile={usageTile(m, w)}
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

const RES_COLUMNS = ['name', 'account', 'product', 'tag', 'usage', 'watch', 'pace', 'trend7', 'cost'];
const RESOURCES = view({
  name: 'Resources',
  columns: RES_COLUMNS,
  group: { fields: ['account', 'category', 'product', 'type', 'tag', 'pace'], default: null },
  sort: { key: 'usage', desc: true },
  width: 'scroll',
} as Partial<CustomViewConfig> & { name: string });

export function ResourcesPage({
  acct,
  tag,
  open,
  product,
}: {
  acct?: string;
  tag?: string;
  open?: string;
  /** A product link: its category tab, with a Product chip in the filter. */
  product?: ProductId;
}) {
  const m = useModel();
  const [w] = usePaceWindow();
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
  // Deleted resources with nothing this billing period stay out until the filter asks for them.
  const [showDeleted, setShowDeleted] = useState(false);
  const onTokens = useCallback(
    (ts: FilterToken[]) =>
      setShowDeleted(ts.some((t) => t.key === 'status' && !t.not && /deleted/i.test(t.value))),
    [],
  );
  const openRes = (id: string | undefined) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, open: id }), replace: true });
  const phone = useIsMobile();
  // biome-ignore lint/correctness/useExhaustiveDependencies: openRes only navigates.
  const domain = useMemo(() => resourceDomain(m, openRes, w, phone, acct), [m, w, phone, acct]);
  const current = open ? m.resource[open] : undefined;
  // The drawer keeps showing the last resource while it slides shut.
  const last = useRef(current);
  if (current) last.current = current;
  const drawer = last.current;
  const a = acct ? m.account[acct] : undefined;
  const scoped = m.resources.filter(
    (r) =>
      !r.total &&
      (showDeleted || !m.archived(r)) &&
      (!acct || r.acct === acct) &&
      (!tag || m.tagsOf(r).includes(tag)),
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
        ...(tag ? [{ key: 'tag', value: tag }] : []),
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
          { label: 'Resources', to: tag ? `/a/${a.id}/resources` : undefined },
        ]
      : [{ label: 'All resources', to: tag ? '/resources' : undefined }]),
    ...(tag ? [{ label: <TagMark m={m} name={tag} withName />, name: tag }] : []),
  ];
  const cost = rows.reduce((s, r) => s + m.info(r).cost, 0);
  const fcost = rows.reduce((s, r) => s + m.info(r).fcost, 0);
  return (
    <>
      <LumenLayout
        key={`${acct ?? ''}|${tag ?? ''}|${product ?? ''}|${tab}`}
        crumbs={crumbs}
        meta={tag ? 'Everything with this tag' : 'Main metric month to date, today on Free'}
        intro={
          <div className="flex flex-col gap-3">
            {tag && (
              <TileRow aria-label="Tag">
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
        onTokens={onTokens}
        actions={
          <>
            <PaceWindowPicker />
            {tag && (
              <TagForm
                m={m}
                edit={tag}
                onDone={(n) => n !== tag && navigate({ to: '.', search: { tag: n } })}
              >
                <Button size="sm" variant="ghost">
                  <Palette className="size-4" />
                  Edit tag
                </Button>
              </TagForm>
            )}
          </>
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

// ---------- Tags ----------

const TAGS = view({
  name: 'Tags',
  columns: ['name', 'account', 'key', 'resources', 'where', 'local', 'inherited'],
  group: { fields: ['account', 'kind', 'where'], default: 'account' },
  sort: { key: 'resources', desc: true },
} as Partial<CustomViewConfig> & { name: string });
const ACCOUNT_TAGS = view({
  name: 'Tags',
  columns: ['name', 'key', 'resources', 'where', 'local', 'inherited'],
  group: { fields: ['kind', 'where'], default: 'kind' },
  sort: { key: 'resources', desc: true },
} as Partial<CustomViewConfig> & { name: string });

/**
 * One account's own tags (or every account's, by account), where each is kept, and the bulk bar
 * to edit, merge or delete them.
 */
export function TagsPage({ acct }: { acct?: string }) {
  const m = useModel();
  const saved = useSavedView(acct ? 'account-tags' : 'tags', acct ? ACCOUNT_TAGS : TAGS);
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
  const rows = useMemo(() => tagRows(m, acct), [m, acct]);
  const domain = useMemo(() => tagDomain(m), [m]);
  const a = acct ? m.account[acct] : undefined;
  const crumbs = a ? [{ label: a.name, to: `/a/${a.id}` }, { label: 'Tags' }] : [{ label: 'Tags' }];
  if (!m.accounts.length || (acct && !a)) return <Waiting m={m} crumbs={crumbs} />;
  const access = tagAccessLine(m);
  const tagged = new Set(rows.flatMap((t) => t.ids)).size;
  const local = new Set(rows.flatMap((t) => t.ids.filter((id) => m.tags.local[id]?.length))).size;
  const live = m.resources.filter((r) => !r.total && !m.archived(r) && (!acct || r.acct === acct)).length;
  const write = acct ? m.tags.access[acct] : undefined;
  return (
    <>
      <LumenLayout
        crumbs={crumbs}
        meta={
          (acct ? write?.write : m.tags.readAt) && m.tags.readAt
            ? `Cloudflare resource tags, read ${new Date(m.tags.readAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : 'Kept in usageflare until a token can write tags'
        }
        actions={
          <>
            <MoveToCloudflare m={m} acct={acct} />
            <TagForm m={m} acct={acct}>
              <Button size="sm">New tag</Button>
            </TagForm>
          </>
        }
        intro={
          <TileRow fill aria-label="Tags">
            <Tile
              label="Projects"
              value={new Set(rows.filter((t) => t.kind === 'Project').map((t) => t.name)).size}
              caption={`${new Set(rows.filter((t) => t.kind !== 'Project').map((t) => t.name)).size} other Cloudflare tags`}
            />
            <Tile label="Tagged resources" value={tagged} caption={`of ${live}`} />
            <Tile
              label="Only in usageflare"
              value={local}
              caption={stayShort(m, acct) ?? 'Not saved in Cloudflare'}
              valueClassName={local ? 'text-warning' : undefined}
            />
            {acct ? (
              <Tile
                label="Saved in Cloudflare"
                value={write?.write ? 'Yes' : 'No'}
                caption={
                  write?.write
                    ? 'Its token writes tags'
                    : (write?.error ?? 'Add Account › Tag › Edit to its token')
                }
              />
            ) : (
              <Tile
                label="Saved in Cloudflare"
                value={`${access.yes} of ${access.of}`}
                caption={access.yes ? access.names.join(' · ') : 'Add Account › Tag › Edit to a token'}
              />
            )}
          </TileRow>
        }
        domain={domain}
        rows={rows}
        load={m.load}
        selection={selection}
        rowTitle={(t) => t.name}
        {...saved}
      />
      <TagBulkBar m={m} keys={[...selKeys]} onSelect={setSel} />
    </>
  );
}

/**
 * The watchdog page: what the Worker's alarm found abnormal in the last 30 days (spikes, surges,
 * new movers, limits crossed, pace to a cap, accounts it couldn't read), one line each, and when
 * it last checked each account. The alarm does the reading (worker/watchdog.ts); this page only
 * shows what it wrote.
 */
import {
  apiJson,
  DetailsTable,
  LumenLayout,
  lumenToast,
  NoteLine,
  type PaceWindow,
  PaceWindowPicker,
  ShareMeter,
  type StatusMessage,
  Tile,
  TileRow,
  UnitValue,
  useLumenLoad,
  usePaceWindow,
  type ViewDomain,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Building2, Clock, Gauge, RefreshCw, Server, ShieldCheck, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { HOURLY_SLOTS, METRIC, PRODUCT } from '../shared/catalog';
import { KIND_LABEL, type WatchEvent, type WatchKind } from '../shared/watchdog';
import { amountParts, limitDomain, view } from './domains';
import { fmt, type Model, pctText, type Usage, usd, useModel } from './model';
import { MeterPaceCell, paceOf } from './pace';
import { useSavedView } from './pages';
import { ProductIcon } from './products';

export interface StoredEvent extends WatchEvent {
  seen: number;
  text: string;
  sent: string[];
  failed: string[];
}

export interface WatchdogStatus {
  next: number | null;
  accounts: Record<string, { name: string; at: string; ok: boolean; error?: string; readAt?: string }>;
  events: StoredEvent[];
}

const KEY = ['watchdog'];
const DAY = 86_400_000;

/** The watchdog's findings, re-read every 5 minutes while a page is open (its alarm's pace). */
export function useWatchdog() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiJson<WatchdogStatus>('/api/watchdog', undefined, 'watchdog'),
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Found in the last day, newest first. */
export const lastDay = (s: WatchdogStatus | undefined) =>
  (s?.events ?? []).filter((e) => Date.now() - e.seen < DAY);

/**
 * What needs doing: a limit burning fast or crossed, an account it can't read, one of your rules.
 * Spikes, sustained runs and new movers are kept as context and never sent.
 */
export const ACTION = new Set<WatchKind>(['burn', 'cost', 'level', 'blind', 'rule']);
const tierOf = (e: StoredEvent) => (ACTION.has(e.kind) ? 'Needs action' : 'Unusual, not sent');

/** The sidebar's count: what needs doing today. */
export const unusual = (s: WatchdogStatus | undefined) =>
  lastDay(s).filter((e) => ACTION.has(e.kind) && e.kind !== 'level').length;

/** The status bar's line: the newest finding, and how many more there were today. */
export function watchdogMessages(s: WatchdogStatus | undefined): StatusMessage[] {
  const recent = lastDay(s).filter((e) => ACTION.has(e.kind) && e.kind !== 'level');
  const blind = Object.values(s?.accounts ?? {}).filter((a) => !a.ok);
  return [
    ...blind.map((a) => ({ text: `Watchdog can't read ${a.name}`, tone: 'warning' as const })),
    ...recent.map((e) => ({ text: `${KIND_LABEL[e.kind]}: ${e.text}`, tone: 'warning' as const })),
  ];
}

const xText = (e: StoredEvent) =>
  e.kind === 'cost'
    ? `${Math.round(e.x * 100)}%`
    : e.kind === 'burn'
      ? `${e.x >= 0.1 ? Math.round(e.x * 100) : (e.x * 100).toFixed(1)}%`
      : e.kind === 'level' || e.kind === 'runsOut'
        ? `${Math.round(e.x * 100)}%`
        : e.kind === 'new'
          ? 'New'
          : e.kind === 'blind' || e.kind === 'rule'
            ? '—'
            : `${e.x >= 10 ? Math.round(e.x) : e.x.toFixed(1)}×`;

/** An amount in its meter's unit, or nothing (a dash) when there is none to show. */
function Amount({ e, v }: { e: StoredEvent; v: number }) {
  if (e.kind === 'blind' || !(v > 0)) return null;
  if (e.kind === 'cost')
    return (
      <span title={e.text}>
        <UnitValue value={v.toFixed(2)} unit="USD" />
      </span>
    );
  const [n, unit] = amountParts(v, METRIC[e.metric]?.unit ?? '');
  return (
    <span title={e.text}>
      <UnitValue value={n} unit={unit} />
    </span>
  );
}

const meterOf = (e: StoredEvent) => {
  const m = METRIC[e.metric];
  return m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : '—';
};

/** Newest first, and within one check: can't read, spike, surge, new mover, pace, limit. */
const BUCKET = 10 * 60_000;
const RANK: Record<WatchKind, number> = {
  burn: 7,
  cost: 7,
  blind: 6,
  rule: 5,
  spike: 4,
  surge: 3,
  new: 2,
  runsOut: 1,
  level: 0,
};

const TONE: Record<WatchKind, string> = {
  spike: 'text-warning',
  surge: 'text-warning',
  new: '',
  level: '',
  runsOut: 'text-warning',
  blind: 'text-destructive',
  rule: 'text-warning',
  burn: 'text-destructive',
  cost: 'text-destructive',
};

/** The hourly slots a burn's window covers (ending at its check), or null when outside the read. */
function windowSlots(e: StoredEvent, hoursFrom: string | undefined): [number, number] | null {
  const from = hoursFrom ? Date.parse(hoursFrom) : Number.NaN;
  if (!Number.isFinite(from)) return null;
  const end = Math.floor((Date.parse(e.at) - from) / 3_600_000);
  const k = Math.max(1, Math.ceil((e.level ?? 60) / 60));
  if (end < 0 || end > HOURLY_SLOTS - 1) return null;
  return [Math.max(0, end - k + 1), end];
}

/** Who used the meter in the event's window, most first: the culprit is the top row. */
function Culprits({ m, e, u }: { m: Model; e: StoredEvent; u: Usage }) {
  const win = e.kind === 'burn' ? windowSlots(e, u.a.hoursFrom) : null;
  const unit = u.m.unit;
  const rows = (
    win
      ? m.resources
          .filter((r) => r.acct === e.acct && r.hourly?.[e.metric])
          .map((r) => {
            const h = r.hourly?.[e.metric] ?? [];
            let v = 0;
            for (let i = win[0]; i <= win[1]; i++) v += h[i] ?? 0;
            return { r, v };
          })
      : u.parts.map((p) => ({ r: p.r, v: p.v }))
  )
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 12);
  const total = rows.reduce((t, x) => t + x.v, 0);
  if (!rows.length)
    return <p className="text-muted-foreground text-sm">No resource used it in this window.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        {win
          ? `Use in the alarm's window (${win[1] - win[0] + 1} h ending at its check), most first.`
          : 'Use this period, most first.'}
      </p>
      <DetailsTable
        head={[
          { label: 'Resource', grow: true },
          { label: win ? 'In window' : 'Used', right: true },
          { label: 'Share', right: true },
          { label: 'This period', right: true },
        ]}
        rows={rows.map((x, i) => ({
          key: x.r.id,
          cells: [
            <span key="n" className="inline-flex min-w-0 items-center gap-2">
              <ProductIcon id={x.r.product} />
              <span
                className={`truncate ${i === 0 && x.v / total >= 0.5 ? 'font-medium text-destructive' : ''}`}
              >
                {x.r.name}
              </span>
            </span>,
            <span key="v" className="num">
              {fmt(x.v, unit)}
            </span>,
            <span key="s" className="num">
              {pctText(x.v / total)}
            </span>,
            <span key="p" className="num">
              {fmt(u.parts.find((p) => p.r.id === x.r.id)?.v ?? 0, unit)}
            </span>,
          ],
        }))}
      />
    </div>
  );
}

/** Who drives a Paid account's forecast usage charges, most first: the culprit is the top row. */
function CostCulprits({ m, e }: { m: Model; e: StoredEvent }) {
  const rows = m.resources
    .filter((r) => r.acct === e.acct)
    .map((r) => ({ r, v: m.info(r).fcost }))
    .filter((x) => x.v >= 0.005)
    .sort((a, b) => b.v - a.v)
    .slice(0, 12);
  const total = rows.reduce((t, x) => t + x.v, 0);
  if (!rows.length) return <p className="text-muted-foreground text-sm">{e.text}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{e.text}</p>
      <DetailsTable
        head={[
          { label: 'Resource', grow: true },
          { label: 'Month end', right: true },
          { label: 'Share', right: true },
        ]}
        rows={rows.map((x, i) => ({
          key: x.r.id,
          cells: [
            <span key="n" className="inline-flex min-w-0 items-center gap-2">
              <ProductIcon id={x.r.product} />
              <span
                className={`truncate ${i === 0 && x.v / total >= 0.5 ? 'font-medium text-destructive' : ''}`}
              >
                {x.r.name}
              </span>
            </span>,
            <span key="v" className="num">
              {usd(x.v)}
            </span>,
            <span key="s" className="num">
              {pctText(x.v / total)}
            </span>,
          ],
        }))}
      />
    </div>
  );
}

/**
 * The distance beside the speed: where the event's account meter stands now (share of its
 * allowance used this period) and when the pace window's rate takes it to the cap.
 */
function watchDomain(
  m: Model,
  accountName: (id: string) => string,
  usageOf: (e: StoredEvent) => Usage | undefined,
  w: PaceWindow,
): ViewDomain<StoredEvent> {
  const meter = limitDomain(m, w).details ?? [];
  const reuse = (id: string) => {
    const d = meter.find((x) => x.id === id);
    return d
      ? [
          {
            id: d.id,
            label: d.label,
            icon: d.icon,
            open: true,
            render: (e: StoredEvent) => {
              const u = usageOf(e);
              return u ? (
                d.render(u)
              ) : (
                <p className="text-muted-foreground text-sm">No limit on this meter.</p>
              );
            },
          },
        ]
      : [];
  };
  return {
    details: [
      {
        id: 'culprit',
        label: 'Who used it',
        icon: Server,
        open: true,
        render: (e) => {
          if (e.kind === 'cost') return <CostCulprits m={m} e={e} />;
          const u = usageOf(e);
          return u ? (
            <Culprits m={m} e={e} u={u} />
          ) : (
            <p className="text-muted-foreground text-sm">{e.text}</p>
          );
        },
      },
      ...reuse('pace'),
      ...reuse('daily'),
    ],
    id: 'watchdog',
    rowKey: (e) => e.key,
    text: (e) => [e.text, e.name, KIND_LABEL[e.kind], accountName(e.acct)],
    fields: [
      {
        key: 'what',
        label: 'What',
        icon: Activity,
        format: 'text',
        value: (e) => e.name,
        render: (e) => {
          const m = METRIC[e.metric];
          return (
            <span className="inline-flex min-w-0 items-center gap-2" title={e.text}>
              {m ? <ProductIcon id={m.product} /> : <Building2 className="size-4 shrink-0" />}
              <span className="truncate">{e.name}</span>
            </span>
          );
        },
      },
      {
        key: 'tier',
        label: 'Tier',
        icon: ShieldCheck,
        format: 'text',
        value: tierOf,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'by',
        label: 'Culprit',
        icon: Server,
        format: 'text',
        value: (e) =>
          (e.kind === 'burn' || e.kind === 'cost') && e.rid ? (m.resource[e.rid]?.name ?? null) : null,
        render: (e) => {
          const r = (e.kind === 'burn' || e.kind === 'cost') && e.rid ? m.resource[e.rid] : undefined;
          return r ? (
            <span className="inline-flex min-w-0 items-center gap-2" title={e.text}>
              <ProductIcon id={r.product} />
              <span className="truncate">{r.name}</span>
            </span>
          ) : null;
        },
        filterable: true,
      },
      {
        key: 'kind',
        label: 'Kind',
        icon: Zap,
        format: 'text',
        value: (e) => KIND_LABEL[e.kind],
        render: (e) => (
          <span className={`whitespace-nowrap ${TONE[e.kind]}`} title={e.text}>
            {KIND_LABEL[e.kind]}
          </span>
        ),
        filterable: true,
        groupable: true,
      },
      {
        key: 'x',
        label: 'Normal ×',
        icon: Gauge,
        format: 'number',
        value: (e) => e.x,
        render: (e) => (
          <span className="num whitespace-nowrap" title={e.text}>
            {xText(e)}
          </span>
        ),
      },
      {
        key: 'value',
        label: 'Amount',
        icon: Activity,
        format: 'number',
        note: 'the hour (spike), the hourly average (surge, new mover) or the period so far (limits)',
        value: (e) => (e.kind === 'blind' ? null : e.value),
        render: (e) => <Amount e={e} v={e.value} />,
      },
      {
        key: 'normal',
        label: 'Baseline',
        icon: Gauge,
        format: 'number',
        note: 'its normal hour, or the allowance for limits',
        value: (e) => (e.normal > 0 ? e.normal : null),
        render: (e) => <Amount e={e} v={e.normal} />,
        hideOnPhone: true,
      },
      {
        key: 'used',
        label: 'Limit used',
        icon: Gauge,
        format: 'percent',
        note: "the account meter's share of its allowance this period, now",
        value: (e) => {
          const u = usageOf(e);
          return u && !u.payg && e.kind !== 'blind' ? u.pct : null;
        },
        render: (e) => {
          const u = usageOf(e);
          if (!u || u.payg || e.kind === 'blind') return null;
          return <ShareMeter value={u.pct} label={pctText(u.pct)} />;
        },
      },
      {
        key: 'lands',
        label: 'Hits limit',
        icon: Clock,
        format: 'number',
        note: "when the account meter reaches its allowance at the pace window's rate, now",
        value: (e) => {
          const u = usageOf(e);
          const p = u && e.kind !== 'blind' ? paceOf(u, w) : null;
          return p ? (p.hits ? p.eta : null) : null;
        },
        render: (e) => {
          const u = usageOf(e);
          if (!u || u.payg || e.kind === 'blind') return null;
          return <MeterPaceCell u={u} w={w} />;
        },
      },
      {
        key: 'meter',
        label: 'Meter',
        icon: Gauge,
        format: 'text',
        value: meterOf,
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'account',
        label: 'Account',
        icon: Building2,
        format: 'text',
        value: (e) => accountName(e.acct),
        filterable: true,
        groupable: true,
        hideOnPhone: true,
      },
      {
        key: 'when',
        label: 'Found',
        icon: Clock,
        format: 'text',
        // One check reads every account within a minute or two: inside the same 10 minutes, what
        // moved sorts before limits. Only the sort sees it; the cell shows the real time.
        value: (e) => new Date(Math.floor(e.seen / BUCKET) * BUCKET + RANK[e.kind] * 1000).toISOString(),
        render: (e) => (
          <time className="text-muted-foreground" dateTime={new Date(e.seen).toISOString()}>
            {new Date(e.seen).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        ),
      },
      {
        key: 'sent',
        label: 'Sent to',
        icon: ShieldCheck,
        format: 'text',
        value: (e) => (e.sent.length ? e.sent.join(', ') : e.failed.length ? 'Failed' : 'Here only'),
        render: (e) => (
          <span
            className={`whitespace-nowrap ${e.failed.length ? 'text-destructive' : 'text-muted-foreground'}`}
            title={e.failed.length ? `Failed: ${e.failed.join(', ')}` : undefined}
          >
            {e.sent.length
              ? e.sent.map((t) => (t.startsWith('wh_') ? 'webhook' : t)).join(', ')
              : e.failed.length
                ? 'Failed'
                : 'Here only'}
          </span>
        ),
        filterable: true,
        hideOnPhone: true,
      },
    ],
  };
}

const WATCHDOG = view({
  name: 'Watchdog',
  columns: ['what', 'by', 'kind', 'x', 'value', 'used', 'lands', 'account', 'when', 'sent'],
  group: { fields: ['tier', 'kind', 'account', 'meter'], default: 'tier' },
  sort: { key: 'when', desc: true },
});

export function WatchdogPage() {
  const m = useModel();
  const q = useWatchdog();
  const qc = useQueryClient();
  const load = useLumenLoad(q);
  const saved = useSavedView('watchdog-burn', WATCHDOG);
  const [w] = usePaceWindow();
  const run = useMutation({
    mutationFn: () => apiJson<WatchdogStatus>('/api/watchdog/run', { method: 'POST' }, 'watchdog.run'),
    onSuccess: (s) => {
      qc.setQueryData(KEY, s);
      lumenToast.success('Checking every account now');
      // Each account takes a step of its own: read again once they've had time.
      setTimeout(() => void qc.invalidateQueries({ queryKey: KEY }), 20_000);
    },
  });
  const names = useMemo(
    () => ({
      ...Object.fromEntries(Object.entries(q.data?.accounts ?? {}).map(([id, a]) => [id, a.name])),
      ...Object.fromEntries(m.accounts.map((a) => [a.id, a.name])),
    }),
    [m.accounts, q.data],
  );
  const domain = useMemo(
    () =>
      watchDomain(
        m,
        (id) => names[id] ?? id,
        (e) => m.usage.find((u) => u.a.id === e.acct && u.m.key === e.metric),
        w,
      ),
    [m, names, w],
  );
  const rows = q.data?.events ?? [];
  const today = lastDay(q.data);
  const checks = Object.values(q.data?.accounts ?? {});
  const last = checks
    .map((c) => c.at)
    .sort()
    .at(-1);
  const blind = checks.filter((c) => !c.ok);
  const count = (k: WatchKind[]) => today.filter((e) => k.includes(e.kind)).length;
  return (
    <LumenLayout
      crumbs={[{ label: 'Watchdog' }]}
      meta="A limit used up too fast, and who is using it"
      actions={
        <>
          <PaceWindowPicker />
          <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
            <RefreshCw className={run.isPending ? 'animate-spin' : undefined} />
            Check now
          </Button>
        </>
      }
      intro={
        <>
          {blind.length > 0 && (
            <NoteLine
              icon={ShieldCheck}
              title={`Can't read ${blind.map((b) => b.name).join(', ')}`}
              note={blind[0]?.error ?? 'Cloudflare did not answer'}
            />
          )}
          <TileRow fill aria-label="Watchdog">
            <Tile
              label="Burning fast"
              value={count(['burn'])}
              caption="A limit used too fast, last 24 h"
              valueClassName={count(['burn']) ? 'text-loss' : undefined}
            />
            <Tile label="Limits crossed" value={count(['level'])} caption="Last 24 hours" />
            <Tile
              label="Unusual, not sent"
              value={count(['spike', 'surge', 'new'])}
              caption="Moves that use little of a limit"
            />
            <Tile
              label="Last check"
              value={
                last ? new Date(last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'
              }
              caption={`${checks.length - blind.length} of ${checks.length} accounts read`}
            />
          </TileRow>
        </>
      }
      domain={domain}
      rows={rows}
      load={load}
      rowTitle={(e) => e.text}
      {...saved}
    />
  );
}

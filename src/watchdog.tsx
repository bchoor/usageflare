/**
 * The watchdog page: what the Worker's alarm found abnormal in the last 30 days (spikes, surges,
 * new movers, limits crossed, pace to a cap, accounts it couldn't read), one line each, and when
 * it last checked each account. The alarm does the reading (worker/watchdog.ts); this page only
 * shows what it wrote.
 */
import {
  apiJson,
  LumenLayout,
  lumenToast,
  NoteLine,
  type StatusMessage,
  Tile,
  TileRow,
  useLumenLoad,
  type ViewDomain,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Building2, Clock, Gauge, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { METRIC, PRODUCT } from '../shared/catalog';
import { KIND_LABEL, type WatchEvent, type WatchKind } from '../shared/watchdog';
import { view } from './domains';
import { useModel } from './model';
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

/** The sidebar's count: what moved today; limits crossed have their own page. */
export const unusual = (s: WatchdogStatus | undefined) => lastDay(s).filter((e) => e.kind !== 'level').length;

/** The status bar's line: the newest finding, and how many more there were today. */
export function watchdogMessages(s: WatchdogStatus | undefined): StatusMessage[] {
  const recent = lastDay(s).filter((e) => e.kind !== 'level');
  const blind = Object.values(s?.accounts ?? {}).filter((a) => !a.ok);
  return [
    ...blind.map((a) => ({ text: `Watchdog can't read ${a.name}`, tone: 'warning' as const })),
    ...recent.map((e) => ({ text: `${KIND_LABEL[e.kind]}: ${e.text}`, tone: 'warning' as const })),
  ];
}

const xText = (e: StoredEvent) =>
  e.kind === 'level' || e.kind === 'runsOut'
    ? `${Math.round(e.x * 100)}%`
    : e.kind === 'new'
      ? 'New'
      : e.kind === 'blind'
        ? '—'
        : `${e.x >= 10 ? Math.round(e.x) : e.x.toFixed(1)}×`;

const meterOf = (e: StoredEvent) => {
  const m = METRIC[e.metric];
  return m ? `${PRODUCT[m.product]?.label ?? m.product} ${m.label}` : '—';
};

/** Newest first, and within one check: can't read, spike, surge, new mover, pace, limit. */
const BUCKET = 10 * 60_000;
const RANK: Record<WatchKind, number> = { blind: 5, spike: 4, surge: 3, new: 2, runsOut: 1, level: 0 };

const TONE: Record<WatchKind, string> = {
  spike: 'text-warning',
  surge: 'text-warning',
  new: '',
  level: '',
  runsOut: 'text-warning',
  blind: 'text-destructive',
};

function watchDomain(accountName: (id: string) => string): ViewDomain<StoredEvent> {
  return {
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
  columns: ['what', 'kind', 'x', 'meter', 'account', 'when', 'sent'],
  group: { fields: ['kind', 'account', 'meter'], default: null },
  sort: { key: 'when', desc: true },
});

export function WatchdogPage() {
  const m = useModel();
  const q = useWatchdog();
  const qc = useQueryClient();
  const load = useLumenLoad(q);
  const saved = useSavedView('watchdog', WATCHDOG);
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
  const domain = useMemo(() => watchDomain((id) => names[id] ?? id), [names]);
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
      meta="Usage that moves far from its normal, beside the fixed limits"
      actions={
        <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          <RefreshCw className={run.isPending ? 'animate-spin' : undefined} />
          Check now
        </Button>
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
            <Tile label="Spikes and surges" value={count(['spike', 'surge'])} caption="Last 24 hours" />
            <Tile label="New movers" value={count(['new'])} caption="No history, now busy" />
            <Tile label="Limits" value={count(['level', 'runsOut'])} caption="Crossed or on pace to" />
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

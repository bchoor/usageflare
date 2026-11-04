/**
 * Settings ▸ Alerts says what is worth telling you, Settings ▸ Channels where it goes. Both read
 * and write the watchdog's one settings record (worker/watchdog.ts, `/api/notifications`): limits
 * and the watchdog's own findings are judged on one 5 minute step and sent through one set of
 * channels. The grid of rules × channels and the channels themselves are Lumen's
 * NotificationsSettings, drawn in two sections (`parts`). Below the grid, your own rules on any
 * meter (src/rules.tsx).
 */
import {
  apiJson,
  ErrorLine,
  NotificationsSettings,
  SettingRow,
  SettingsFooter,
  useClock,
} from '@columenlabs/lumen-ui';
import { Switch } from '@columenlabs/lumen-ui/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BurnSettings } from '../shared/burn';
import type { CostSettings } from '../shared/cost';
import type { Rule } from '../shared/rules';
import type { AlertLevel } from './api';
import { BurnSettingsBlock, CostSettingsBlock } from './burn';
import { RulesSettings } from './rules';
import { useWatchdog } from './watchdog';

const API = '/api/notifications';
/** The kit's own cache key for the section, so the grid and these rows share one answer. */
const KEY = ['notifications', API];
const SENDER = "the hub's email relay";

interface Alerting {
  on: boolean;
  level: AlertLevel;
}

const LEVELS: { id: AlertLevel; label: string; note: string }[] = [
  { id: 'watch', label: 'Watch', note: 'Every level crossed: Watch, 90% and 100%' },
  { id: 'soon', label: 'Will exceed', note: '90% and 100% of an allowance' },
  { id: 'over', label: 'Over', note: 'Only past 100% of an allowance' },
];

function useAlerting() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () =>
      apiJson<{ alerting?: Alerting; rules?: Rule[]; burn?: BurnSettings; cost?: CostSettings }>(
        API,
        undefined,
        'notifications',
      ),
  });
  const save = useMutation({
    mutationFn: (a: Alerting) =>
      apiJson<{ alerting?: Alerting }>(
        `${API}/alerting`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) },
        'notifications.alerting',
      ),
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });
  return { q, save };
}

/** Settings ▸ Alerts: sending on or off, the limit level, then the rules × channels grid. */
export function AlertsSettings() {
  const { q, save } = useAlerting();
  const wd = useWatchdog();
  const clock = useClock();
  const a: Alerting = q.data?.alerting ?? { on: true, level: 'soon' };
  const next = wd.data?.next;
  const last = Object.values(wd.data?.accounts ?? {})
    .map((c) => c.at)
    .sort()
    .at(-1);
  if (q.isError) return <ErrorLine error={q.error} />;
  return (
    <div className="flex flex-col gap-4">
      <SettingRow label="Send alerts" htmlFor="alerts-on">
        <Switch
          id="alerts-on"
          checked={a.on}
          disabled={!q.data || save.isPending}
          onCheckedChange={(on) => save.mutate({ ...a, on })}
        />
      </SettingRow>
      <BurnSettingsBlock value={q.data?.burn} />
      <CostSettingsBlock value={q.data?.cost} />
      <SettingRow label="Limit alert at" description={LEVELS.find((l) => l.id === a.level)?.note}>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={a.level}
          disabled={!q.data || save.isPending}
          onValueChange={(v) => v && save.mutate({ ...a, level: v as AlertLevel })}
          aria-label="Limit alert at"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem key={l.id} value={l.id} className="whitespace-nowrap px-3">
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <ErrorLine error={save.error} />
      <NotificationsSettings api={API} product="usageflare" sender={SENDER} parts="events" />
      <div className="flex flex-col gap-2">
        <h4 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">Your rules</h4>
        <RulesSettings rules={q.data?.rules ?? []} />
      </div>
      <SettingsFooter>
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {a.on ? '' : 'Off: found and shown here, sent nowhere · '}
          {last ? `Checked ${clock(last)}` : 'First check within 5 minutes'}
          {next ? ` · next ${clock(new Date(next).toISOString())}` : ''} · each alert once a day per channel
        </span>
      </SettingsFooter>
    </div>
  );
}

/** Settings ▸ Channels: where alerts go, set up once for every rule. */
export function ChannelsSettings() {
  return <NotificationsSettings api={API} product="usageflare" sender={SENDER} parts="channels" />;
}

/**
 * Settings ▸ Alerts ▸ Your rules: one condition on one meter, like a price alert on one stock
 * (shared/rules.ts). Each rule is a row that opens in place to its own settings; the reading now
 * and how often it would have fired come from the usage the app already holds, so editing a rule
 * costs no call. The watchdog judges saved rules on its own read (worker/watchdog.ts) and sends
 * them through the channels ticked for them in the grid above.
 */
import {
  apiJson,
  ErrorLine,
  type FormIssue,
  LumenConfirm,
  LumenExpandList,
  LumenExpandRow,
  type LumenOption,
  LumenSelector,
  lumenToast,
  SaveButton,
  SettingRow,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Switch } from '@columenlabs/lumen-ui/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { METRIC, METRICS, PRODUCT, type Resource } from '../shared/catalog';
import {
  autoName,
  COND,
  condText,
  MAX_RULES,
  meterName,
  RULE_CONDS,
  type Rule,
  type RuleCond,
  readingText,
  readNow,
  replay,
  seriesOf,
} from '../shared/rules';
import { amountParts } from './domains';
import { type Model, useModel } from './model';

const API = '/api/notifications';
const KEY = ['notifications', API];

const fmt = (v: number, unit: string) => amountParts(v, unit).filter(Boolean).join(' ');
const newId = () =>
  `r_${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** A starting number for each condition: something that would rarely fire. */
const START: Record<RuleCond, number> = {
  above: 0,
  below: 0,
  share: 80,
  change: 50,
  xnormal: 5,
  momentum: 70,
  toCap: 24,
  silent: 6,
};

function useRuleSave() {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (r: Rule) =>
      apiJson<unknown>(
        `${API}/rules/${r.id}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) },
        'notifications.rule',
      ),
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiJson<unknown>(`${API}/rules/${id}`, { method: 'DELETE' }, 'notifications.rule'),
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });
  return { save, remove };
}

/** The reading now and the replay, for a rule on the data the app holds. */
function judgeLocal(m: Model, r: Rule) {
  const a = m.account[r.acct];
  if (!a) return null;
  const s = seriesOf(r, a, m.resources, m.dates);
  if (!s) return null;
  return { now: readNow(r, s), past: replay(r, s) };
}

/** The list of rules, then a row to add one. */
export function RulesSettings({ rules }: { rules: Rule[] }) {
  const m = useModel();
  const [open, setOpen] = useState<string | null>(null);
  const names = Object.fromEntries(m.accounts.map((a) => [a.id, a.name]));
  return (
    <div className="flex flex-col gap-2">
      <LumenExpandList>
        {rules.map((r) => {
          const j = judgeLocal(m, r);
          return (
            <LumenExpandRow
              key={r.id}
              id={r.id}
              open={open === r.id}
              onOpenChange={(o) => setOpen(o ? r.id : null)}
              name={r.name}
              meta={`${names[r.acct] ?? 'Account'}${j?.now ? ` · now ${readingText(r, j.now, fmt)}` : ''}`}
              badge={
                <span className="whitespace-nowrap text-muted-foreground text-xs">
                  {!r.on ? 'Off' : j?.past ? `${j.past.fires} in ${j.past.span}` : '—'}
                </span>
              }
            >
              <RuleForm m={m} rule={r} onDone={() => setOpen(null)} />
            </LumenExpandRow>
          );
        })}
        {rules.length < MAX_RULES && (
          <LumenExpandRow
            id="new"
            open={open === 'new'}
            onOpenChange={(o) => setOpen(o ? 'new' : null)}
            icon={<Plus className="size-4" />}
            name="Add a rule"
            meta="A value, % of the cap, % change, × normal, momentum, time to cap or silence"
          >
            {open === 'new' && <RuleForm m={m} onDone={() => setOpen(null)} />}
          </LumenExpandRow>
        )}
      </LumenExpandList>
    </div>
  );
}

function RuleForm({ m, rule, onDone }: { m: Model; rule?: Rule; onDone: () => void }) {
  const { save, remove } = useRuleSave();
  const first = m.accounts[0]?.id ?? '';
  const [d, setD] = useState<Rule>(
    () =>
      rule ?? {
        id: newId(),
        on: true,
        name: '',
        acct: first,
        metric: 'workers.req',
        cond: 'above',
        value: 0,
        window: 'day',
        created_at: new Date().toISOString(),
      },
  );
  const set = (p: Partial<Rule>) => setD((x) => ({ ...x, ...p }));
  const mine = useMemo(() => m.resources.filter((r) => r.acct === d.acct), [m.resources, d.acct]);
  const used = (r: Resource, k: string) => (r.series[k] ?? []).reduce((t, v) => t + v, 0);
  const meters: LumenOption[] = METRICS.filter(
    (x) => x.kind === 'sum' && !x.noApi && mine.some((r) => used(r, x.key) > 0),
  ).map((x) => ({
    value: x.key,
    label: meterName(x.key),
    group: PRODUCT[x.product]?.label ?? x.product,
    detail: x.unit || undefined,
  }));
  const holders: LumenOption[] = [
    { value: '*', label: 'The whole account' },
    ...mine
      .filter((r) => used(r, d.metric) > 0 && !r.total)
      .sort((a, b) => used(b, d.metric) - used(a, d.metric))
      .map((r) => ({
        value: r.id,
        label: r.name,
        detail: fmt(used(r, d.metric), METRIC[d.metric]?.unit ?? ''),
      })),
  ];
  const unit = COND[d.cond].unit || METRIC[d.metric]?.unit || '';
  const j = judgeLocal(m, d);
  const name = d.name.trim() || autoName(d, fmt);
  const issues: FormIssue[] = [
    ...(!meters.some((o) => o.value === d.metric)
      ? [{ where: 'Meter', message: 'Pick a meter with use on this account', target: 'rule-meter' }]
      : []),
    ...(!Number.isFinite(d.value) || (d.value <= 0 && d.cond !== 'below')
      ? [{ where: 'Value', message: 'A number above 0', target: 'rule-value' }]
      : []),
    ...(d.cond === 'momentum' && (d.value <= 0 || d.value >= 100)
      ? [{ where: 'Value', message: 'An RSI between 0 and 100', target: 'rule-value' }]
      : []),
  ];
  const hourOnly = COND[d.cond].hourly && j === null;
  return (
    <div className="flex flex-col gap-3">
      {rule && (
        <SettingRow label="On" htmlFor={`rule-on-${d.id}`}>
          <Switch
            id={`rule-on-${d.id}`}
            checked={d.on}
            disabled={save.isPending}
            onCheckedChange={(on) => {
              set({ on });
              save.mutate({ ...rule, on });
            }}
          />
        </SettingRow>
      )}
      <SettingRow label="Account">
        <LumenSelector
          label="Account"
          options={m.accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={d.acct}
          onChange={(acct) => set({ acct, rid: undefined })}
        />
      </SettingRow>
      <SettingRow label="Meter">
        <LumenSelector
          id="rule-meter"
          label="Meter"
          options={meters}
          value={d.metric}
          onChange={(metric) => set({ metric, rid: undefined })}
          placeholder="Pick a meter"
        />
      </SettingRow>
      <SettingRow label="On what">
        <LumenSelector
          label="On what"
          options={holders}
          value={d.rid ?? '*'}
          onChange={(v) => set({ rid: v === '*' ? undefined : v })}
        />
      </SettingRow>
      <SettingRow label="When" description={COND[d.cond].hint}>
        <LumenSelector
          label="When"
          options={RULE_CONDS.map((c) => ({ value: c, label: COND[c].label, description: COND[c].hint }))}
          value={d.cond}
          onChange={(c) => {
            const cond = c as RuleCond;
            const now = judgeLocal(m, { ...d, cond, value: 1 })?.now?.value ?? 0;
            set({
              cond,
              value: cond === 'above' ? Math.max(1, Math.ceil(now * 1.5)) : START[cond],
              window: cond === 'above' || cond === 'below' ? (d.window ?? 'day') : undefined,
              dir: cond === 'change' || cond === 'momentum' ? (d.dir ?? 'up') : undefined,
            });
          }}
        />
      </SettingRow>
      {(d.cond === 'above' || d.cond === 'below') && (
        <SettingRow label="Over">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={d.window ?? 'day'}
            onValueChange={(v) => v && set({ window: v as Rule['window'] })}
            aria-label="Over"
          >
            <ToggleGroupItem value="hour" className="px-3">
              An hour
            </ToggleGroupItem>
            <ToggleGroupItem value="day" className="px-3">
              A day
            </ToggleGroupItem>
            {d.cond === 'above' && (
              <ToggleGroupItem value="month" className="px-3">
                The month
              </ToggleGroupItem>
            )}
          </ToggleGroup>
        </SettingRow>
      )}
      {(d.cond === 'change' || d.cond === 'momentum') && (
        <SettingRow label="Which way">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={d.dir ?? 'up'}
            onValueChange={(v) => v && set({ dir: v as Rule['dir'] })}
            aria-label="Which way"
          >
            <ToggleGroupItem value="up" className="px-3">
              {d.cond === 'momentum' ? 'At or over' : 'Up'}
            </ToggleGroupItem>
            <ToggleGroupItem value="down" className="px-3">
              {d.cond === 'momentum' ? 'At or under' : 'Down'}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
      )}
      <SettingRow label="Value" htmlFor="rule-value">
        <div className="flex items-center gap-2">
          <Input
            id="rule-value"
            type="number"
            inputMode="decimal"
            className="num w-32"
            value={Number.isFinite(d.value) ? d.value : ''}
            onChange={(e) => set({ value: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
          />
          {unit && <span className="whitespace-nowrap text-muted-foreground text-sm">{unit}</span>}
        </div>
      </SettingRow>
      <SettingRow label="Name" htmlFor={`rule-name-${d.id}`}>
        <Input
          id={`rule-name-${d.id}`}
          className="w-full min-w-0 sm:w-72"
          maxLength={80}
          placeholder={autoName(d, fmt)}
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </SettingRow>
      <p className="truncate text-muted-foreground text-xs" title={condText(d, fmt)}>
        {hourOnly
          ? 'This meter has no hourly read on this account: pick another condition'
          : j?.now
            ? `Now ${readingText(d, j.now, fmt)}${j.now.met ? ' (met)' : ''}${j.past ? ` · would have fired ${j.past.fires}× in the last ${j.past.span}` : ''}`
            : 'Not enough history yet to read it'}
      </p>
      <ErrorLine error={save.error ?? remove.error} />
      <div className="flex items-center justify-end gap-2">
        {rule && (
          <LumenConfirm
            title={`Delete ${rule.name}?`}
            description="It stops being checked and leaves Settings ▸ Alerts."
            action="Delete"
            onConfirm={() =>
              remove.mutateAsync(rule.id).then(() => {
                lumenToast.success(`Deleted ${rule.name}`);
                onDone();
              })
            }
          >
            <Button size="icon" variant="ghost" aria-label="Delete rule" title="Delete rule">
              <Trash2 />
            </Button>
          </LumenConfirm>
        )}
        <SaveButton
          issues={issues}
          busy={save.isPending}
          label={rule ? 'Save rule' : 'Add rule'}
          onSave={() =>
            save.mutate(
              { ...d, name },
              {
                onSuccess: () => {
                  lumenToast.success(rule ? `Saved ${name}` : `Added ${name}`);
                  onDone();
                },
              },
            )
          }
        />
      </div>
    </div>
  );
}

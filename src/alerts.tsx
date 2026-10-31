/**
 * Settings ▸ Alerts: tell someone when a limit's status changes. The Worker checks every account
 * every 15 minutes on a Durable Object alarm (worker/watch.ts) and sends one message per account
 * by email (a Resend-style API) and webhook. Keys and the webhook address are write-only.
 */
import {
  ErrorLine,
  type FormIssue,
  IconButton,
  KeyTestLine,
  LumenConfirm,
  LumenExpandList,
  LumenExpandRow,
  lumenToast,
  SaveButton,
  SettingRow,
  TestBadge,
  useClock,
} from '@columenlabs/lumen-ui';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { Label } from '@columenlabs/lumen-ui/ui/label';
import { Switch } from '@columenlabs/lumen-ui/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@columenlabs/lumen-ui/ui/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Trash2, Webhook } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type AlertLevel, type AlertsInput, type AlertsReply, api } from './api';
import { STATUS_LABEL } from './model';

const KEY = ['alerts'];
const LEVELS: { id: AlertLevel; label: string; note: string }[] = [
  { id: 'watch', label: 'Watch', note: 'Past the Watch at share of an allowance' },
  { id: 'soon', label: 'Will exceed', note: 'Forecast past the allowance before the period ends' },
  { id: 'over', label: 'Over', note: 'Past the allowance: billed, or blocked on Free' },
];

function useAlerts() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: api.alerts });
  const save = useMutation({
    mutationFn: (body: AlertsInput) => api.putAlerts(body),
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });
  return { q, save, set: (r: AlertsReply) => qc.setQueryData(KEY, r) };
}

/** The current settings as a save body, with one part changed. */
const bodyOf = (r: AlertsReply, patch: Partial<AlertsInput>): AlertsInput => ({
  on: r.alerts.on,
  level: r.alerts.level,
  ...patch,
});

export function AlertsSettings() {
  const { q, save, set } = useAlerts();
  const clock = useClock();
  const r = q.data;
  const test = useMutation({ mutationFn: api.testAlerts, onSuccess: set });
  if (!r) return <ErrorLine error={q.error} />;
  const a = r.alerts;
  const s = r.state;
  const targets = !!a.email || !!a.webhook;
  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        label="Send alerts"
        htmlFor="alerts-on"
        description={targets ? 'Checks every 15 minutes while on.' : 'Add an email or a webhook below first.'}
      >
        <Switch
          id="alerts-on"
          checked={a.on}
          disabled={save.isPending}
          onCheckedChange={(on) => save.mutate(bodyOf(r, { on }))}
        />
      </SettingRow>
      <SettingRow label="Alert at" description={LEVELS.find((l) => l.id === a.level)?.note}>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={a.level}
          onValueChange={(v) => v && save.mutate(bodyOf(r, { level: v as AlertLevel }))}
          aria-label="Alert at"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem key={l.id} value={l.id} className="whitespace-nowrap px-3">
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <ErrorLine error={save.error} />
      <LumenExpandList defaultOpen={targets ? null : 'email'}>
        <EmailRow r={r} />
        <WebhookRow r={r} />
      </LumenExpandList>
      {targets && <KeyTestLine test={a.test} run={() => test.mutateAsync()} />}
      <p className="text-muted-foreground text-xs">
        {s.checkedAt
          ? `Last check ${clock(s.checkedAt)} · ${s.accounts} account${s.accounts === 1 ? '' : 's'} · ${
              s.firing.length
                ? `${s.firing.length} at ${STATUS_LABEL[a.level]} or worse`
                : 'nothing at the alert level'
            }`
          : a.on && targets
            ? 'First check within a minute.'
            : 'Not checking: alerts are off.'}
        {s.nextAt && a.on ? ` · next ${clock(s.nextAt)}` : ''}
        {s.error ? ` · last error: ${s.error}` : ''}
      </p>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

const isHttps = (u: string) => /^https:\/\/[^\s/]+/.test(u.trim());

function EmailRow({ r }: { r: AlertsReply }) {
  const { save } = useAlerts();
  const cur = r.alerts.email;
  const [url, setUrl] = useState(cur?.url ?? 'https://api.resend.com');
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(cur?.from ?? '');
  const [to, setTo] = useState(cur?.to ?? '');
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setUrl(cur?.url ?? 'https://api.resend.com');
    setFrom(cur?.from ?? '');
    setTo(cur?.to ?? '');
  }, [cur?.url, cur?.from, cur?.to]);
  const issues: FormIssue[] = [
    ...(isHttps(url)
      ? []
      : [{ where: 'API address', message: 'An https address', target: 'alert-email-url' }]),
    ...(cur || key.trim().length >= 8
      ? []
      : [{ where: 'API key', message: 'Paste the API key', target: 'alert-email-key' }]),
    ...(from.trim().length >= 3
      ? []
      : [{ where: 'From', message: 'Who it comes from', target: 'alert-email-from' }]),
    ...(/^\S+@\S+\.\S+$/.test(to.trim())
      ? []
      : [{ where: 'Send to', message: 'An email address', target: 'alert-email-to' }]),
  ];
  const changed =
    !cur || key.trim() !== '' || url.trim() !== cur.url || from.trim() !== cur.from || to.trim() !== cur.to;
  const submit = () =>
    save.mutate(
      bodyOf(r, {
        email: { url: url.trim(), from: from.trim(), to: to.trim(), key: key.trim() || undefined },
      }),
      {
        onSuccess: () => {
          setKey('');
          lumenToast.success('Email saved');
        },
      },
    );
  return (
    <LumenExpandRow
      id="email"
      name="Email"
      icon={<Mail className="size-4" />}
      meta={cur ? `To ${cur.to}` : 'A Resend-style email API'}
      badge={cur ? <TestBadge test={r.alerts.test} ok="Set" /> : undefined}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!issues.length && changed) submit();
        }}
      >
        <Field id="alert-email-url" label="API address (POST …/emails)">
          <Input id="alert-email-url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field id="alert-email-key" label="API key">
          <Input
            id="alert-email-key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={cur ? `Saved ••${cur.keyHint}; paste to replace` : 're_…'}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:flex-1">
            <Field id="alert-email-from" label="From">
              <Input
                id="alert-email-from"
                value={from}
                placeholder="Usage <alerts@example.com>"
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
          </div>
          <div className="sm:flex-1">
            <Field id="alert-email-to" label="Send to">
              <Input
                id="alert-email-to"
                type="email"
                value={to}
                placeholder="you@example.com"
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          {cur && <IconButton icon={Trash2} label="Remove email" onClick={() => setRemoving(true)} />}
          <SaveButton
            type="submit"
            issues={issues}
            label="Save email"
            busy={save.isPending}
            disabled={!changed}
          />
        </div>
      </form>
      <LumenConfirm
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the email?"
        description="Alerts stop going by email; the key is deleted."
        action="Remove"
        onConfirm={() => save.mutateAsync(bodyOf(r, { email: null }))}
      />
    </LumenExpandRow>
  );
}

function WebhookRow({ r }: { r: AlertsReply }) {
  const { save } = useAlerts();
  const cur = r.alerts.webhook;
  const [url, setUrl] = useState('');
  const [removing, setRemoving] = useState(false);
  const issues: FormIssue[] = isHttps(url)
    ? []
    : [{ where: 'Address', message: 'An https address', target: 'alert-hook-url' }];
  const submit = () =>
    save.mutate(bodyOf(r, { webhook: { url: url.trim() } }), {
      onSuccess: () => {
        setUrl('');
        lumenToast.success('Webhook saved');
      },
    });
  return (
    <LumenExpandRow
      id="webhook"
      name="Webhook"
      icon={<Webhook className="size-4" />}
      meta={cur ? cur.hint : 'Gets each change as JSON'}
      badge={cur ? <TestBadge test={r.alerts.test} ok="Set" /> : undefined}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!issues.length) submit();
        }}
      >
        <Field id="alert-hook-url" label={cur ? 'Replace the address' : 'Address'}>
          <Input
            id="alert-hook-url"
            type="url"
            autoComplete="off"
            value={url}
            placeholder={cur ? `Saved: ${cur.hint}` : 'https://…'}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-end gap-1">
          {cur && <IconButton icon={Trash2} label="Remove webhook" onClick={() => setRemoving(true)} />}
          <SaveButton
            type="submit"
            issues={issues}
            label="Save webhook"
            busy={save.isPending}
            disabled={!url.trim()}
          />
        </div>
      </form>
      <LumenConfirm
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the webhook?"
        description="Alerts stop going to it."
        action="Remove"
        onConfirm={() => save.mutateAsync(bodyOf(r, { webhook: null }))}
      />
    </LumenExpandRow>
  );
}

import {
  ErrorLine,
  LumenExpandList,
  LumenExpandRow,
  lumenToast,
  SettingActions,
  SettingField,
  SettingStatus,
  SettingValue,
  sectionHealth,
  settingHealth,
  useClock,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type SecretInfo, slug } from './api';

const SECRETS = ['secrets'];

/**
 * Permissions the dashboard needs: read for usage (GraphQL usage, resource lists, plan and billed
 * usage from Billing; that one is optional and can be removed) and Tag edit for tags; the
 * dashboard's token template pre-fills them. Keys from Cloudflare's token template reference. Workers CI,
 * Containers, Vectorize, Hyperdrive and Workers AI have no published template key: add those by hand.
 */
const TOKEN_PERMISSIONS = [
  ...[
    'account_analytics',
    'account_settings',
    'workers_scripts',
    'workers_kv_storage',
    'workers_r2',
    'd1',
    'queues',
    'billing',
  ].map((key) => ({ key, type: 'read' })),
  // Saves tags as Cloudflare resource tags; take it out to keep the token read-only.
  { key: 'tag', type: 'edit' },
];
const CREATE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
  accountId: '*',
  zoneId: 'all',
  name: 'usageflare',
})}`;

/** What a token may do, from its last test: usage reads, and tags where Account › Tag reaches. */
function scopeOf(s: SecretInfo) {
  if (s.kind === 'cf_tags_token')
    return { text: 'Tags', note: 'A tags-only token: it writes tags, never reads usage' };
  const n = s.test?.tagAccounts;
  const of = s.test?.accounts;
  if (n === undefined) return { text: 'Read', note: 'Test it to see whether it can write tags' };
  if (!n) return { text: 'Read', note: 'Read-only: add Account › Tag › Edit to save tags in Cloudflare' };
  return {
    text: 'Read + tags',
    note: `${n === of ? 'Reaches tags in every account' : `Reaches tags in ${n} of ${of} accounts`}; saving them needs Tag Edit, not just Read`,
  };
}

/** The section's pill: the worst token wins. */
export function useTokensHealth() {
  const q = useQuery({ queryKey: SECRETS, queryFn: api.secrets });
  const secrets = q.data?.secrets ?? [];
  const failed = secrets.filter((s) => s.test && !s.test.ok).map((s) => s.label);
  return {
    health: sectionHealth(secrets.map((s) => settingHealth(true, s.test))),
    healthTitle: failed.length ? `Failed: ${failed.join(', ')}` : undefined,
  };
}

/** Settings ▸ Cloudflare API tokens: write-only, the API shows only the last four characters. */
export function TokensSettings() {
  const q = useQuery({ queryKey: SECRETS, queryFn: api.secrets });
  const secrets = q.data?.secrets ?? [];
  return (
    <div className="flex flex-col">
      <ErrorLine error={q.error} />
      <LumenExpandList>
        {secrets.map((s) => (
          <TokenRow key={s.name} secret={s} />
        ))}
      </LumenExpandList>
      <AddToken taken={secrets.map((s) => s.name)} />
    </div>
  );
}

function TokenRow({ secret }: { secret: SecretInfo }) {
  const qc = useQueryClient();
  const clock = useClock();
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: SECRETS });
  const replace = useMutation({
    mutationFn: () => api.putSecret(secret.name, { kind: secret.kind, label: secret.label, value }),
    onSuccess: async () => {
      setValue('');
      setReplacing(false);
      await api.testSecret(secret.name).catch(() => null);
      lumenToast.success(`Replaced ${secret.label}`);
      return refresh();
    },
  });
  const scope = scopeOf(secret);
  const t = secret.test;
  const accounts = t?.accounts;
  return (
    <LumenExpandRow
      id={secret.name}
      icon={<KeyRound className="size-4 shrink-0 text-muted-foreground" />}
      name={secret.label}
      meta={[
        `••${secret.last4}`,
        accounts === undefined ? null : `${accounts} account${accounts === 1 ? '' : 's'}`,
        scope.text,
      ]
        .filter(Boolean)
        .join(' · ')}
      status={
        <SettingStatus
          health={settingHealth(true, t)}
          title={t ? `${t.ok ? t.detail : t.error} · ${clock(t.at)}` : undefined}
        />
      }
      actions={
        <SettingActions
          test={t}
          onTest={() => api.testSecret(secret.name).finally(refresh)}
          remove={{
            label: `Delete ${secret.label}`,
            title: `Delete ${secret.label}?`,
            description: 'usageflare stops reading the accounts only this token reaches.',
            action: 'Delete',
            run: () => api.deleteSecret(secret.name).then(refresh),
          }}
        />
      }
    >
      <SettingField label="Token" htmlFor={`replace-${secret.name}`}>
        {replacing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.length >= 8) replace.mutate();
            }}
          >
            <Input
              id={`replace-${secret.name}`}
              type="password"
              autoComplete="off"
              placeholder="New token value"
              className="h-8"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <Button type="submit" size="sm" disabled={value.length < 8 || replace.isPending}>
              Replace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                setValue('');
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <SettingValue
            label="Token"
            value={`••••${secret.last4}`}
            mono
            onReplace={() => setReplacing(true)}
          />
        )}
      </SettingField>
      <SettingField label="Scope" info={scope.note}>
        <span className="truncate text-sm">{scope.text}</span>
      </SettingField>
      <SettingField label="Saved">
        <span className="truncate text-sm" title={secret.updatedBy}>
          {clock(secret.updatedAt)} by {secret.updatedBy}
        </span>
      </SettingField>
      <ErrorLine error={replace.error} />
    </LumenExpandRow>
  );
}

function AddToken({ taken }: { taken: string[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const name = slug(label);
  const exists = taken.includes(name);
  const add = useMutation({
    mutationFn: () =>
      api.putSecret(name, { kind: 'cf_api_token', label: label.trim(), value }, { create: true }),
    onSuccess: async ({ secret }) => {
      setLabel('');
      setValue('');
      setOpen(false);
      await api.testSecret(secret.name).catch(() => null);
      lumenToast.success(`Added ${secret.label}`);
      return qc.invalidateQueries({ queryKey: SECRETS });
    },
  });
  if (!open)
    return (
      <button
        type="button"
        className="flex min-h-11 items-center gap-2 px-1 font-medium text-sm"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        Add token
      </button>
    );
  return (
    <form
      className="flex flex-col border-t pt-1 pl-8"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <SettingField label="Name" htmlFor="token-name">
        <Input
          id="token-name"
          placeholder="Personal"
          className="h-8"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-invalid={exists || undefined}
        />
      </SettingField>
      <SettingField
        label="Token"
        htmlFor="token-value"
        info="One token per set of accounts. The Create link pre-fills read access for usage and Account › Tag › Edit for tags; leave Tag out to keep usageflare read-only."
      >
        <Input
          id="token-value"
          type="password"
          autoComplete="off"
          placeholder="Cloudflare API token"
          className="h-8"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </SettingField>
      <div className="mt-1 flex min-h-10 items-center gap-2 border-t pt-2 text-sm">
        <span className="min-w-0 flex-1 truncate">
          {exists ? (
            <span className="text-loss">A token with that name exists</span>
          ) : (
            <a className="underline" href={CREATE_TOKEN_URL} target="_blank" rel="noreferrer">
              Create one in Cloudflare ↗
            </a>
          )}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name || exists || value.length < 8 || add.isPending}>
          Save
        </Button>
      </div>
      <ErrorLine error={add.error} />
    </form>
  );
}

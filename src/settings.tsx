import {
  ErrorLine,
  KeyTestLine,
  LumenConfirm,
  lumenToast,
  SettingRow,
  TestBadge,
} from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type SecretInfo, slug } from './api';

const SECRETS = ['secrets'];

/** Read-only permissions the dashboard needs; the dashboard's token template pre-fills them. */
const TOKEN_PERMISSIONS = [
  { key: 'account_analytics', type: 'read' },
  { key: 'analytics', type: 'read' },
  { key: 'workers_scripts', type: 'read' },
  { key: 'workers_kv_storage', type: 'read' },
];
const CREATE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
  accountId: '*',
  zoneId: 'all',
  name: 'usageflare (read-only)',
})}`;

/** Settings ▸ Cloudflare API tokens: write-only, the API shows only the last four characters. */
export function TokensSettings() {
  const q = useQuery({ queryKey: SECRETS, queryFn: api.secrets });
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Tokens for metrics the Worker's bindings can't read (GraphQL Analytics, account usage). They are
        encrypted before they're stored and can't be read back here: replace or delete them instead.
      </p>
      <ErrorLine error={q.error} />
      {q.data?.secrets.map((s) => (
        <TokenRow key={s.name} secret={s} />
      ))}
      {q.data && q.data.secrets.length === 0 && <p className="text-sm">No tokens yet.</p>}
      <AddToken taken={q.data?.secrets.map((s) => s.name) ?? []} />
    </div>
  );
}

function TokenRow({ secret }: { secret: SecretInfo }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: SECRETS });
  const replace = useMutation({
    mutationFn: () => api.putSecret(secret.name, { kind: secret.kind, label: secret.label, value }),
    onSuccess: () => {
      setValue('');
      lumenToast.success(`Replaced ${secret.label}`);
      return refresh();
    },
  });
  return (
    <SettingRow
      label={secret.label}
      description={
        <span className="flex flex-col gap-1">
          <span className="font-mono">••••{secret.last4}</span>
          <KeyTestLine test={secret.test} run={() => api.testSecret(secret.name).then(refresh)} />
        </span>
      }
    >
      <div className="flex flex-col items-end gap-2">
        <TestBadge test={secret.test} ok="Valid" />
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder="New value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`New value for ${secret.label}`}
          />
          <Button
            variant="outline"
            disabled={value.length < 8 || replace.isPending}
            onClick={() => replace.mutate()}
          >
            Replace
          </Button>
          <LumenConfirm
            title={`Delete ${secret.label}?`}
            action="Delete"
            onConfirm={() => api.deleteSecret(secret.name).then(refresh)}
          >
            <Button variant="ghost">Delete</Button>
          </LumenConfirm>
        </div>
        <ErrorLine error={replace.error} />
      </div>
    </SettingRow>
  );
}

function AddToken({ taken }: { taken: string[] }) {
  const qc = useQueryClient();
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
      await api.testSecret(secret.name).catch(() => null);
      lumenToast.success(`Added ${secret.label}`);
      return qc.invalidateQueries({ queryKey: SECRETS });
    },
  });
  return (
    <form
      className="flex flex-col gap-2 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Add a token</h3>
        <Button variant="link" size="sm" asChild>
          <a href={CREATE_TOKEN_URL} target="_blank" rel="noreferrer">
            Create a read-only token in Cloudflare ↗
          </a>
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Label (e.g. Personal account)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="max-w-60"
          aria-label="Token label"
        />
        <Input
          type="password"
          autoComplete="off"
          placeholder="Cloudflare API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="max-w-80"
          aria-label="Token value"
        />
        <Button type="submit" disabled={!name || exists || value.length < 8 || add.isPending}>
          Save
        </Button>
      </div>
      {exists && (
        <p className="text-destructive text-sm">A token with that label exists; replace it above.</p>
      )}
      <ErrorLine error={add.error} />
    </form>
  );
}

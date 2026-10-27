import { ErrorLine, LumenConfirm, lumenToast, useClock } from '@columenlabs/lumen-ui';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@columenlabs/lumen-ui/ui/dropdown-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@columenlabs/lumen-ui/ui/hover-card';
import { Input } from '@columenlabs/lumen-ui/ui/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, RefreshCw } from 'lucide-react';
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

/** Columns of the token list: name, accounts, scope, status, actions. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_6rem_4.5rem_4.5rem]';

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

/** Settings ▸ Cloudflare API tokens: write-only, the API shows only the last four characters. */
export function TokensSettings() {
  const q = useQuery({ queryKey: SECRETS, queryFn: api.secrets });
  const secrets = q.data?.secrets ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        One token per set of accounts. With Account › Tag › Edit it also saves tags in Cloudflare.
      </p>
      <ErrorLine error={q.error} />
      {secrets.length > 0 && (
        <div className="flex flex-col">
          <div className={`${GRID} border-b pb-2 text-muted-foreground text-xs`}>
            <span>Token</span>
            <span className="hidden text-right sm:block">Accounts</span>
            <span className="hidden sm:block">Scope</span>
            <span>Status</span>
            <span className="sr-only">Actions</span>
          </div>
          {secrets.map((s) => (
            <TokenRow key={s.name} secret={s} />
          ))}
        </div>
      )}
      {q.data && secrets.length === 0 && <p className="text-sm">No tokens yet.</p>}
      <AddToken taken={secrets.map((s) => s.name)} />
    </div>
  );
}

function TokenRow({ secret }: { secret: SecretInfo }) {
  const qc = useQueryClient();
  const clock = useClock();
  const [replacing, setReplacing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [value, setValue] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: SECRETS });
  const test = useMutation({ mutationFn: () => api.testSecret(secret.name), onSettled: refresh });
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
  return (
    <div className="flex flex-col border-b py-2 last:border-b-0">
      <div className={GRID}>
        <span className="min-w-0 truncate text-sm">
          {secret.label} <span className="font-mono text-muted-foreground text-xs">••{secret.last4}</span>
        </span>
        <span className="num hidden text-right text-sm sm:block">{t?.accounts ?? '—'}</span>
        <span className="hidden text-sm sm:block" title={scope.note}>
          {scope.text}
        </span>
        <HoverCard openDelay={150}>
          <HoverCardTrigger asChild>
            <span className="cursor-default whitespace-nowrap text-sm">
              {!t ? (
                <span className="text-muted-foreground">Not tested</span>
              ) : t.ok ? (
                <span>
                  <span className="text-gain">✓</span> Valid
                </span>
              ) : (
                <span className="text-loss">✕ Failed</span>
              )}
            </span>
          </HoverCardTrigger>
          <HoverCardContent className="flex w-72 flex-col gap-1 text-xs">
            <span className="font-medium text-sm">{secret.label}</span>
            {t ? (
              <>
                <span>Tested {clock(t.at)}</span>
                <span className={t.ok ? 'text-muted-foreground' : 'text-loss'}>
                  {t.ok ? t.detail : t.error}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Not tested yet</span>
            )}
            <span className="text-muted-foreground">{scope.note}</span>
            <span className="text-muted-foreground">
              Saved {clock(secret.updatedAt)} by {secret.updatedBy}
            </span>
          </HoverCardContent>
        </HoverCard>
        <span className="flex items-center justify-end">
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Test ${secret.label}`}
            title="Test again"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            <RefreshCw className={`size-4 ${test.isPending ? 'animate-spin' : ''}`} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={`More for ${secret.label}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setReplacing(true)}>Replace…</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {replacing && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.length >= 8) replace.mutate();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder="New token value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`New value for ${secret.label}`}
            autoFocus
          />
          <Button type="submit" disabled={value.length < 8 || replace.isPending}>
            Replace
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setReplacing(false);
              setValue('');
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      <ErrorLine error={replace.error ?? test.error} />
      <LumenConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${secret.label}?`}
        description="usageflare stops reading the accounts only this token reaches."
        action="Delete"
        onConfirm={() => api.deleteSecret(secret.name).then(refresh)}
      />
    </div>
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
      className="flex flex-col gap-2 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Add a token</h3>
        <Button variant="link" size="sm" asChild>
          <a href={CREATE_TOKEN_URL} target="_blank" rel="noreferrer">
            Create one in Cloudflare ↗
          </a>
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Name (e.g. Personal)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="max-w-52"
          aria-label="Token name"
        />
        <Input
          type="password"
          autoComplete="off"
          placeholder="Cloudflare API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="max-w-64"
          aria-label="Token value"
        />
        <Button type="submit" disabled={!name || exists || value.length < 8 || add.isPending}>
          Save
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        The link pre-fills read access for usage and Account › Tag › Edit for tags. Leave Tag out to keep
        usageflare read-only; tags then stay in usageflare.
      </p>
      {exists && <p className="text-destructive text-sm">A token with that name exists; replace it above.</p>}
      <ErrorLine error={add.error} />
    </form>
  );
}

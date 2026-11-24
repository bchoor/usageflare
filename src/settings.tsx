import {
  ErrorLine,
  LumenConnection,
  LumenExpandList,
  lumenToast,
  sectionHealth,
  settingHealth,
  useClock,
} from '@columenlabs/lumen-ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
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
        <AddToken taken={secrets.map((s) => s.name)} />
      </LumenExpandList>
    </div>
  );
}

const TOKEN_INFO =
  'One token per set of accounts. Create one in Cloudflare pre-fills read access for usage and Account › Tag › Edit for tags; leave Tag out to keep usageflare read-only.';

/** A token's value: typed as a password, at least 8 characters. */
const valueOk = (value: string | undefined) => {
  if ((value ?? '').trim().length >= 8) return true;
  lumenToast.error('That token is too short');
  return false;
};

function TokenRow({ secret }: { secret: SecretInfo }) {
  const qc = useQueryClient();
  const clock = useClock();
  const refresh = () => qc.invalidateQueries({ queryKey: SECRETS });
  const scope = scopeOf(secret);
  const accounts = secret.test?.accounts;
  return (
    <LumenConnection
      id={secret.name}
      name={secret.label}
      logo={<KeyRound className="size-4 shrink-0 text-muted-foreground" />}
      meta={[
        `••${secret.last4}`,
        accounts === undefined ? null : `${accounts} account${accounts === 1 ? '' : 's'}`,
        scope.text,
      ]
        .filter(Boolean)
        .join(' · ')}
      ways={[
        {
          id: 'token',
          label: 'Token',
          set: true,
          ident: `••••${secret.last4}`,
          test: secret.test,
          fields: [{ id: 'value', label: 'Token', secret: true, placeholder: 'New token value' }],
          getUrl: CREATE_TOKEN_URL,
          onSave: async ({ value }) => {
            if (!valueOk(value)) return false;
            await api.putSecret(secret.name, {
              kind: secret.kind,
              label: secret.label,
              value: (value ?? '').trim(),
            });
            await api.testSecret(secret.name).catch(() => null);
            lumenToast.success(`Replaced ${secret.label}`);
            await refresh();
          },
          onTest: () => api.testSecret(secret.name).finally(refresh),
          onRemove: () => api.deleteSecret(secret.name).then(refresh),
          removeLabel: 'Delete',
          removeTitle: `Delete ${secret.label}?`,
          removeText: 'usageflare stops reading the accounts only this token reaches.',
        },
      ]}
      lines={[
        { label: 'Scope', value: scope.text, info: scope.note },
        { label: 'Saved', value: `${clock(secret.updatedAt)} by ${secret.updatedBy}` },
      ]}
    />
  );
}

function AddToken({ taken }: { taken: string[] }) {
  const qc = useQueryClient();
  return (
    <LumenConnection
      id="add-token"
      name="Add a token"
      meta="A Cloudflare API token for one set of accounts"
      logo={<Plus className="size-4 shrink-0 text-muted-foreground" />}
      ways={[
        {
          id: 'token',
          label: 'Token',
          set: false,
          info: TOKEN_INFO,
          addLabel: 'Add token',
          fields: [
            { id: 'label', label: 'Name', placeholder: 'Personal' },
            { id: 'value', label: 'Token', secret: true, placeholder: 'Cloudflare API token' },
          ],
          getUrl: CREATE_TOKEN_URL,
          onSave: async ({ label, value }) => {
            const name = slug(label ?? '');
            if (!name) {
              lumenToast.error('Give the token a name');
              return false;
            }
            if (taken.includes(name)) {
              lumenToast.error('A token with that name exists');
              return false;
            }
            if (!valueOk(value)) return false;
            const { secret } = await api.putSecret(
              name,
              { kind: 'cf_api_token', label: (label ?? '').trim(), value: (value ?? '').trim() },
              { create: true },
            );
            await api.testSecret(secret.name).catch(() => null);
            lumenToast.success(`Added ${secret.label}`);
            await qc.invalidateQueries({ queryKey: SECRETS });
          },
        },
      ]}
    />
  );
}

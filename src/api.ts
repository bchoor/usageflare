import type { KeyTestResult } from '@columenlabs/lumen-ui';
import { apiJson } from '@columenlabs/lumen-ui';

export interface SecretInfo {
  name: string;
  /** `cf_api_token` reads usage (and writes tags with Account › Tag › Edit); `cf_tags_token` is a tags-only token from before. */
  kind: 'cf_api_token' | 'cf_tags_token';
  label: string;
  last4: string;
  updatedAt: string;
  updatedBy: string;
  /** With the accounts the token reaches and how many of them let it read tags. */
  test: (KeyTestResult & { accounts?: number; tagAccounts?: number }) | null;
}

// apiJson sets the JSON content type itself; a second `Content-Type` here would join into
// `application/json, application/json`, which the Worker's validator doesn't read as JSON.
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => apiJson<Me>('/api/me', undefined, 'me'),
  secrets: () => apiJson<{ secrets: SecretInfo[] }>('/api/secrets', undefined, 'secrets.list'),
  putSecret: (
    name: string,
    body: { kind: SecretInfo['kind']; label: string; value: string },
    opts: { create?: boolean } = {},
  ) =>
    apiJson<{ secret: SecretInfo }>(
      `/api/secrets/${name}${opts.create ? '?create' : ''}`,
      json('PUT', body),
      'secrets.put',
    ),
  testSecret: (name: string) =>
    apiJson<{ secret: SecretInfo }>(`/api/secrets/${name}/test`, json('POST'), 'secrets.test'),
  alerts: () => apiJson<AlertsReply>('/api/alerts', undefined, 'alerts'),
  putAlerts: (body: AlertsInput) => apiJson<AlertsReply>('/api/alerts', json('PUT', body), 'alerts.put'),
  testAlerts: () => apiJson<AlertsReply>('/api/alerts/test', json('POST'), 'alerts.test'),
  deleteSecret: (name: string) =>
    fetch(`/api/secrets/${name}`, { method: 'DELETE' }).then((r) => {
      if (!r.ok) throw new Error(`Delete failed (${r.status})`);
    }),
};

/** `Prod account` → `prod-account`: the KV name for a token's label. */
export const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

/** The signed-in person, and the suite this deployment joins (its variables), if any. */
export interface Me {
  email: string;
  suite?: { list?: string; prefsCookie?: string; prefsDomain?: string };
}

/** The lowest status that sends an alert. */
export type AlertLevel = 'watch' | 'soon' | 'over';

/** Settings ▸ Alerts as the Worker answers it (worker/alerts.ts, worker/watch.ts): nothing sealed. */
export interface AlertsReply {
  alerts: {
    on: boolean;
    level: AlertLevel;
    email: { url: string; from: string; to: string; keyHint: string } | null;
    webhook: { hint: string } | null;
    test: KeyTestResult | null;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  state: {
    checkedAt: string | null;
    accounts: number;
    firing: { acct: string; account: string; metric: string; st: string }[];
    nextAt: string | null;
    error: string | null;
  };
}

/** A save: a key or webhook address left out keeps the saved one; `null` removes that target. */
export interface AlertsInput {
  on: boolean;
  level: AlertLevel;
  email?: { url: string; from: string; to: string; key?: string } | null;
  webhook?: { url?: string } | null;
}

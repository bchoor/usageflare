import type { KeyTestResult } from '@columenlabs/lumen-ui';
import { apiJson } from '@columenlabs/lumen-ui';

export interface SecretInfo {
  name: string;
  kind: 'cf_api_token';
  label: string;
  last4: string;
  updatedAt: string;
  updatedBy: string;
  test: KeyTestResult | null;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => apiJson<{ email: string }>('/api/me', undefined, 'me'),
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
  deleteSecret: (name: string) =>
    fetch(`/api/secrets/${name}`, { method: 'DELETE' }).then((r) => {
      if (!r.ok) throw new Error(`Delete failed (${r.status})`);
    }),
};

/** `Prod account` → `prod-account`: the KV name for a label. */
export const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

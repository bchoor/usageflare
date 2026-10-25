/**
 * Reads one Cloudflare account with a read-only token: the resources (REST lists) and 30 days of
 * daily usage per resource (GraphQL Analytics). Anything the token can't read is skipped and named
 * in `missing`, so one absent scope never blanks the whole account.
 */
import { type Account, HISTORY_DAYS, type Plan, type ProductId, type Resource } from '../shared/catalog';

const API = 'https://api.cloudflare.com/client/v4';

class CfError extends Error {}

async function rest<T>(token: string, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: { message: string }[];
  } | null;
  if (!res.ok || !body?.success) throw new CfError(body?.errors?.[0]?.message ?? `HTTP ${res.status}`);
  return body.result as T;
}

/** A paged REST list (Cloudflare `page`/`per_page`), up to 1,000 items. */
async function restList<T>(token: string, path: string, perPage = 100): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const rows = await rest<T[]>(token, `${path}${sep}page=${page}&per_page=${perPage}`);
    out.push(...(rows ?? []));
    if (!rows || rows.length < perPage) break;
  }
  return out;
}

export async function listAccounts(token: string): Promise<{ id: string; name: string }[]> {
  return restList<{ id: string; name: string }>(token, '/accounts', 50);
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: T[] } };
    errors?: { message: string }[] | null;
  } | null;
  if (body?.errors?.length) throw new CfError(body.errors[0]?.message ?? 'GraphQL error');
  const acct = body?.data?.viewer?.accounts?.[0];
  if (!acct) throw new CfError(`GraphQL HTTP ${res.status}`);
  return acct;
}

/** The last `HISTORY_DAYS` UTC dates, oldest first. */
export function historyDates(now = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: HISTORY_DAYS }, (_, i) =>
    new Date(end - (HISTORY_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

type Row = {
  dimensions: Record<string, string>;
  sum?: Record<string, number>;
  max?: Record<string, number>;
  count?: number;
};

/**
 * One usage dataset: the GraphQL field, what to select, and how a row maps to a resource key and to
 * metric values. Keys are matched against the resource lists (ids without dashes, or names).
 */
interface Dataset {
  name: string;
  field: string;
  select: string;
  dims: string[];
  product: ProductId;
  key: (r: Row) => string | null;
  values: (r: Row) => Record<string, number>;
  /** Gauges keep the day's maximum instead of adding rows up. */
  gauge?: boolean;
}

const GB = 1e9;
const norm = (id: string) => id.replaceAll('-', '').toLowerCase();

// R2 operation classes (https://developers.cloudflare.com/r2/pricing/#class-a-operations).
const R2_CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

const DATASETS: Dataset[] = [
  {
    name: 'Workers',
    field: 'workersInvocationsAdaptive',
    select: 'sum { requests cpuTimeUs }',
    dims: ['scriptName'],
    product: 'workers',
    key: (r) => r.dimensions.scriptName ?? null,
    values: (r) => ({ 'workers.req': r.sum?.requests ?? 0, 'workers.cpu': (r.sum?.cpuTimeUs ?? 0) / 1000 }),
  },
  {
    name: 'KV operations',
    field: 'kvOperationsAdaptiveGroups',
    select: 'sum { requests }',
    dims: ['namespaceId', 'actionType'],
    product: 'kv',
    key: (r) => norm(r.dimensions.namespaceId ?? ''),
    // Each operation type has its own allowance and price.
    values: (r) => {
      const key = { read: 'kv.read', write: 'kv.write', delete: 'kv.delete', list: 'kv.list' }[
        r.dimensions.actionType ?? ''
      ];
      return key ? { [key]: r.sum?.requests ?? 0 } : {};
    },
  },
  {
    name: 'KV storage',
    field: 'kvStorageAdaptiveGroups',
    select: 'max { byteCount }',
    gauge: true,
    dims: ['namespaceId'],
    product: 'kv',
    key: (r) => norm(r.dimensions.namespaceId ?? ''),
    values: (r) => ({ 'kv.stor': (r.max?.byteCount ?? 0) / GB }),
  },
  {
    name: 'D1 queries',
    field: 'd1AnalyticsAdaptiveGroups',
    select: 'sum { rowsRead rowsWritten }',
    dims: ['databaseId'],
    product: 'd1',
    key: (r) => norm(r.dimensions.databaseId ?? ''),
    values: (r) => ({ 'd1.read': r.sum?.rowsRead ?? 0, 'd1.write': r.sum?.rowsWritten ?? 0 }),
  },
  {
    name: 'D1 storage',
    field: 'd1StorageAdaptiveGroups',
    select: 'max { databaseSizeBytes }',
    gauge: true,
    dims: ['databaseId'],
    product: 'd1',
    key: (r) => norm(r.dimensions.databaseId ?? ''),
    values: (r) => ({ 'd1.stor': (r.max?.databaseSizeBytes ?? 0) / GB }),
  },
  {
    name: 'R2 operations',
    field: 'r2OperationsAdaptiveGroups',
    select: 'sum { requests }',
    dims: ['bucketName', 'actionType'],
    product: 'r2',
    key: (r) => r.dimensions.bucketName || null,
    values: (r) => {
      const a = r.dimensions.actionType ?? '';
      if (R2_FREE.has(a)) return {};
      return { [R2_CLASS_A.has(a) ? 'r2.a' : 'r2.b']: r.sum?.requests ?? 0 };
    },
  },
  {
    name: 'R2 storage',
    field: 'r2StorageAdaptiveGroups',
    select: 'max { payloadSize metadataSize }',
    gauge: true,
    dims: ['bucketName'],
    product: 'r2',
    key: (r) => r.dimensions.bucketName || null,
    values: (r) => ({ 'r2.stor': ((r.max?.payloadSize ?? 0) + (r.max?.metadataSize ?? 0)) / GB }),
  },
  {
    name: 'Durable Objects requests',
    field: 'durableObjectsInvocationsAdaptiveGroups',
    select: 'sum { requests }',
    dims: ['namespaceId'],
    product: 'do',
    key: (r) => norm(r.dimensions.namespaceId ?? ''),
    values: (r) => ({ 'do.req': r.sum?.requests ?? 0 }),
  },
  {
    // Duration is billed at 128 MB per active object: activeTime (µs) × 0.125 GB.
    name: 'Durable Objects duration',
    field: 'durableObjectsPeriodicGroups',
    select: 'sum { activeTime rowsRead rowsWritten }',
    dims: ['namespaceId'],
    product: 'do',
    key: (r) => norm(r.dimensions.namespaceId ?? ''),
    values: (r) => ({
      'do.dur': ((r.sum?.activeTime ?? 0) / 1e6) * 0.125,
      'do.rowsr': r.sum?.rowsRead ?? 0,
      'do.rowsw': r.sum?.rowsWritten ?? 0,
    }),
  },
  {
    name: 'Durable Objects storage',
    field: 'durableObjectsStorageGroups',
    select: 'max { storedBytes }',
    gauge: true,
    dims: [],
    product: 'do',
    key: () => '*',
    values: (r) => ({ 'do.stor': (r.max?.storedBytes ?? 0) / GB }),
  },
  {
    name: 'Workflows',
    field: 'workflowsAdaptiveGroups',
    select: 'count',
    dims: ['workflowName', 'eventType'],
    product: 'workflows',
    key: (r) => r.dimensions.workflowName || null,
    values: (r) => ({ 'wf.req': r.dimensions.eventType === 'WORKFLOW_START' ? (r.count ?? 0) : 0 }),
  },
  {
    name: 'Containers',
    field: 'containersMetricsAdaptiveGroups',
    select: 'sum { cpuTimeSec allocatedMemory allocatedDisk }',
    dims: ['applicationId'],
    product: 'containers',
    key: (r) => norm(r.dimensions.applicationId ?? ''),
    // CPU is billed on use; memory and disk on what's provisioned (allocated*: unit-seconds).
    values: (r) => ({
      'ct.cpu': (r.sum?.cpuTimeSec ?? 0) / 60,
      'ct.mem': (r.sum?.allocatedMemory ?? 0) / 2 ** 30 / 3600,
      'ct.disk': (r.sum?.allocatedDisk ?? 0) / 1e9 / 3600,
    }),
  },
  {
    name: 'Hyperdrive',
    field: 'hyperdriveQueriesAdaptiveGroups',
    select: 'count',
    dims: ['configId'],
    product: 'hyperdrive',
    key: (r) => norm(r.dimensions.configId ?? ''),
    values: (r) => ({ 'hd.q': r.count ?? 0 }),
  },
  {
    name: 'Workers AI',
    field: 'aiInferenceAdaptiveGroups',
    select: 'sum { totalNeurons }',
    dims: ['modelId'],
    product: 'ai',
    key: (r) => r.dimensions.modelId || null,
    values: (r) => ({ 'ai.neurons': r.sum?.totalNeurons ?? 0 }),
  },
  {
    name: 'Vectorize queries',
    field: 'vectorizeV2QueriesAdaptiveGroups',
    select: 'sum { queriedVectorDimensions }',
    dims: ['indexName'],
    product: 'vectorize',
    key: (r) => r.dimensions.indexName || null,
    values: (r) => ({ 'vec.q': r.sum?.queriedVectorDimensions ?? 0 }),
  },
  {
    name: 'Vectorize storage',
    field: 'vectorizeV2StorageAdaptiveGroups',
    select: 'max { storedVectorDimensions }',
    gauge: true,
    dims: ['indexName'],
    product: 'vectorize',
    key: (r) => r.dimensions.indexName || null,
    values: (r) => ({ 'vec.stor': r.max?.storedVectorDimensions ?? 0 }),
  },
  {
    name: 'Queues',
    field: 'queueMessageOperationsAdaptiveGroups',
    select: 'sum { billableOperations }',
    dims: ['queueId'],
    product: 'queues',
    key: (r) => norm(r.dimensions.queueId ?? ''),
    values: (r) => ({ 'queues.ops': r.sum?.billableOperations ?? 0 }),
  },
  {
    name: 'Workers Builds',
    field: 'workersBuildsBuildMinutesAdaptiveGroups',
    select: 'sum { buildMinutes }',
    dims: [],
    product: 'builds',
    key: () => '*',
    values: (r) => ({ 'builds.min': r.sum?.buildMinutes ?? 0 }),
  },
];

async function fetchDataset(token: string, accountId: string, d: Dataset, dates: string[]) {
  const query = `query($a: string!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $a }) {
    rows: ${d.field}(limit: 10000, filter: { date_geq: $from, date_leq: $to }) { ${d.select} dimensions { date ${d.dims.join(' ')} } }
  } } }`;
  const res = await gql<{ rows: Row[] }>(token, query, { a: accountId, from: dates[0], to: dates.at(-1) });
  return res.rows ?? [];
}

// ---------- Resource lists ----------

interface Inventory {
  resources: Map<string, Resource>;
  /** Analytics key (id without dashes, or name) → resource id, per product. */
  byKey: Map<string, string>;
}

const rid = (acct: string, product: ProductId, name: string) => `${acct}:${product}:${name}`;

function add(
  inv: Inventory,
  acct: string,
  product: ProductId,
  name: string,
  keys: string[],
  extra: Partial<Resource> = {},
) {
  const id = rid(acct, product, name);
  if (!inv.resources.has(id)) inv.resources.set(id, { id, acct, product, name, series: {}, ...extra });
  for (const k of keys) inv.byKey.set(`${product}|${k}`, id);
  return id;
}

type ScriptBinding = {
  type: string;
  name: string;
  namespace_id?: string;
  id?: string;
  bucket_name?: string;
  class_name?: string;
  queue_name?: string;
  workflow_name?: string;
  index_name?: string;
};

async function inventory(token: string, acct: string, missing: string[]): Promise<Inventory> {
  const inv: Inventory = { resources: new Map(), byKey: new Map() };
  const a = `/accounts/${acct}`;
  const tryList = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch {
      missing.push(label);
      return [];
    }
  };
  const [scripts, domains, kvs, d1s, r2, dos, queues, workflows, hyper, vec] = await Promise.all([
    tryList('Workers scripts', () => restList<{ id: string }>(token, `${a}/workers/scripts`)),
    tryList('Workers custom domains', () =>
      restList<{ hostname: string; service: string }>(token, `${a}/workers/domains`),
    ),
    tryList('KV namespaces', () =>
      restList<{ id: string; title: string }>(token, `${a}/storage/kv/namespaces`),
    ),
    tryList('D1 databases', () => restList<{ uuid: string; name: string }>(token, `${a}/d1/database`)),
    tryList(
      'R2 buckets',
      async () =>
        (
          await rest<{ buckets: { name: string; storage_class?: string }[] }>(
            token,
            `${a}/r2/buckets?per_page=1000`,
          )
        ).buckets ?? [],
    ),
    tryList('Durable Objects namespaces', () =>
      restList<{ id: string; name: string; class: string; script: string; use_sqlite?: boolean }>(
        token,
        `${a}/workers/durable_objects/namespaces`,
      ),
    ),
    tryList('Queues', () => restList<{ queue_id: string; queue_name: string }>(token, `${a}/queues`)),
    tryList('Workflows', () => restList<{ id: string; name: string }>(token, `${a}/workflows`)),
    tryList('Hyperdrive configs', () =>
      restList<{ id: string; name: string }>(token, `${a}/hyperdrive/configs`),
    ),
    tryList('Vectorize indexes', () =>
      rest<{ name: string; config?: { dimensions?: number } }[]>(token, `${a}/vectorize/v2/indexes`),
    ),
  ]);

  const kvById = new Map(kvs.map((k) => [norm(k.id), k.title]));
  const d1ById = new Map(d1s.map((d) => [norm(d.uuid), d.name]));
  const doByClass = new Map(dos.map((d) => [d.class, d]));
  const hdById = new Map(hyper.map((h) => [norm(h.id), h.name]));

  for (const k of kvs) add(inv, acct, 'kv', k.title, [norm(k.id)]);
  for (const d of d1s) add(inv, acct, 'd1', d.name, [norm(d.uuid)]);
  for (const b of r2)
    add(inv, acct, 'r2', b.name, [b.name], {
      type: b.storage_class === 'InfrequentAccess' ? 'Infrequent Access' : 'Standard',
    });
  for (const d of dos)
    add(inv, acct, 'do', d.class || d.name, [norm(d.id)], {
      type: d.use_sqlite ? 'SQLite' : 'KV storage',
      detail: d.script ? `Worker ${d.script}` : undefined,
    });
  for (const q of queues) add(inv, acct, 'queues', q.queue_name, [norm(q.queue_id)]);
  for (const w of workflows) add(inv, acct, 'workflows', w.name, [w.name]);
  for (const h of hyper) add(inv, acct, 'hyperdrive', h.name, [norm(h.id)]);
  for (const v of vec)
    add(inv, acct, 'vectorize', v.name, [v.name], {
      detail: v.config?.dimensions ? `${v.config.dimensions} dimensions` : undefined,
    });

  // Bindings: one settings read per Worker (capped so a large account stays inside subrequest limits).
  const routes = new Map<string, string[]>();
  for (const d of domains) routes.set(d.service, [...(routes.get(d.service) ?? []), d.hostname]);
  await Promise.all(
    scripts.slice(0, 60).map(async (s) => {
      let binds: string[] = [];
      try {
        const st = await rest<{ bindings?: ScriptBinding[] }>(
          token,
          `${a}/workers/scripts/${encodeURIComponent(s.id)}/settings`,
        );
        binds = (st.bindings ?? []).flatMap((b): string[] => {
          const kv =
            b.type === 'kv_namespace' && b.namespace_id ? kvById.get(norm(b.namespace_id)) : undefined;
          if (kv) return [rid(acct, 'kv', kv)];
          const d1 = b.type === 'd1' && b.id ? d1ById.get(norm(b.id)) : undefined;
          if (d1) return [rid(acct, 'd1', d1)];
          if (b.type === 'r2_bucket' && b.bucket_name) return [rid(acct, 'r2', b.bucket_name)];
          if (b.type === 'durable_object_namespace' && b.class_name && doByClass.has(b.class_name))
            return [rid(acct, 'do', b.class_name)];
          if (b.type === 'queue' && b.queue_name) return [rid(acct, 'queues', b.queue_name)];
          if (b.type === 'workflow' && b.workflow_name) return [rid(acct, 'workflows', b.workflow_name)];
          if (b.type === 'vectorize' && b.index_name) return [rid(acct, 'vectorize', b.index_name)];
          const hd = b.type === 'hyperdrive' && b.id ? hdById.get(norm(b.id)) : undefined;
          if (hd) return [rid(acct, 'hyperdrive', hd)];
          return [];
        });
      } catch {
        // Bindings are a nicety; the Worker still shows without them.
      }
      add(inv, acct, 'workers', s.id, [s.id], { routes: routes.get(s.id), binds: [...new Set(binds)] });
    }),
  );
  if (scripts.length > 60) missing.push(`Bindings for ${scripts.length - 60} more Workers`);
  return inv;
}

// ---------- Plan ----------

/** Workers Paid shows up as a `workers` rate plan in the account's subscriptions (needs Billing Read). */
async function detectPlan(token: string, acct: string): Promise<Plan | null> {
  try {
    const subs = await rest<{ rate_plan?: { id?: string; public_name?: string } }[]>(
      token,
      `/accounts/${acct}/subscriptions`,
    );
    return subs.some((s) => /workers/i.test(`${s.rate_plan?.id} ${s.rate_plan?.public_name}`))
      ? 'paid'
      : 'free';
  } catch {
    return null;
  }
}

// ---------- One account ----------

export async function readAccount(
  token: string,
  meta: { id: string; name: string; token: string; tokenLabel: string; planOverride?: Plan },
  dates: string[],
): Promise<{ account: Account; resources: Resource[] }> {
  const missing: string[] = [];
  const [inv, detected, rows] = await Promise.all([
    inventory(token, meta.id, missing),
    meta.planOverride ? Promise.resolve(null) : detectPlan(token, meta.id),
    Promise.all(
      DATASETS.map((d) =>
        fetchDataset(token, meta.id, d, dates).catch(() => {
          missing.push(d.name);
          return [] as Row[];
        }),
      ),
    ),
  ]);
  const dayIndex = new Map(dates.map((d, i) => [d, i]));

  DATASETS.forEach((d, i) => {
    for (const row of rows[i] ?? []) {
      const day = dayIndex.get(row.dimensions.date ?? '');
      const key = d.key(row);
      if (day === undefined || key === null) continue;
      let id = inv.byKey.get(`${d.product}|${key}`);
      if (!id) {
        // Usage for something the lists don't show (a deleted resource, an AI model, or a metric
        // Cloudflare only reports account-wide): keep it, so totals still add up.
        const total = key === '*' || key === '__unknown__';
        const name = key === '*' ? 'Whole account' : key === '__unknown__' ? 'Unattributed' : key;
        id = add(
          inv,
          meta.id,
          d.product,
          name,
          [key],
          total
            ? { total: true }
            : {
                detail:
                  d.product === 'ai' ? key : 'Not in the account’s list: deleted, or the token can’t list it',
              },
        );
      }
      const res = inv.resources.get(id);
      if (!res) continue;
      for (const [metric, v] of Object.entries(d.values(row))) {
        const s = res.series[metric] ?? new Array<number>(dates.length).fill(0);
        s[day] = d.gauge ? Math.max(s[day] ?? 0, v) : (s[day] ?? 0) + v;
        res.series[metric] = s;
      }
    }
  });

  const plan = meta.planOverride ?? detected ?? 'free';
  return {
    account: {
      id: meta.id,
      name: meta.name,
      plan,
      planSource: meta.planOverride ? 'set' : detected ? 'detected' : 'assumed',
      token: meta.token,
      tokenLabel: meta.tokenLabel,
      syncedAt: new Date().toISOString(),
      missing,
    },
    resources: [...inv.resources.values()].sort((x, y) => x.name.localeCompare(y.name)),
  };
}

/**
 * Reads one Cloudflare account with a read-only token: the resources (REST lists) and 30 days of
 * daily usage per resource (GraphQL Analytics). Anything the token can't read is skipped and named
 * in `missing`, so one absent scope never blanks the whole account.
 */
import {
  type Account,
  type Billed,
  HISTORY_DAYS,
  type Plan,
  type ProductId,
  type Resource,
} from '../shared/catalog';

const API = 'https://api.cloudflare.com/client/v4';

class CfError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The product isn't turned on in the account (R2 answers 10042): nothing to list, not a missing scope. */
const NOT_ENABLED = new Set([10042]);

async function rest<T>(token: string, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: { message: string; code?: number }[];
  } | null;
  if (!res.ok || !body?.success)
    throw new CfError(
      body?.errors?.[0]?.message ?? `HTTP ${res.status}`,
      body?.errors?.[0]?.code,
      res.status,
    );
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
  /** Most accounts don't use it: a field the token can't read isn't reported as missing. */
  optional?: boolean;
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
    name: 'R2 Data Catalog',
    field: 'r2CatalogDataOperationsAdaptiveGroups',
    select: 'count',
    dims: ['warehouseName'],
    product: 'basin',
    optional: true,
    key: (r) => r.dimensions.warehouseName || null,
    values: (r) => ({ 'basin.ops': r.count ?? 0 }),
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

const RATE_LIMITED = /rate limit/i;

/**
 * Every dataset in one GraphQL request (aliases d0, d1...), so a sync spends one query of the
 * account's analytics budget, not one per dataset. A field the token can't read comes back as an
 * error on its own path while the rest still answer; if the whole request fails, each dataset is
 * asked alone so one missing scope doesn't blank the others.
 */
async function fetchDatasets(token: string, accountId: string, dates: string[], missing: string[]) {
  const field = (d: Dataset, i: number) =>
    `d${i}: ${d.field}(limit: 10000, filter: { date_geq: $from, date_leq: $to }) { ${d.select} dimensions { date ${d.dims.join(' ')} } }`;
  const ask = (fields: string) =>
    `query($a: string!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $a }) { ${fields} } } }`;
  const vars = { a: accountId, from: dates[0], to: dates.at(-1) };
  const run = async (query: string) => {
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: vars }),
    });
    return (await res.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: Record<string, Row[] | null>[] } } | null;
      errors?: { message: string; path?: (string | number)[] }[] | null;
    } | null;
  };
  let rateLimited = false;
  const out: Row[][] = DATASETS.map(() => []);
  const body = await run(ask(DATASETS.map(field).join('\n')));
  const acct = body?.data?.viewer?.accounts?.[0];
  if (acct) {
    const failed = new Set((body?.errors ?? []).map((e) => String(e.path?.at(-1) ?? '')));
    DATASETS.forEach((d, i) => {
      if (failed.has(`d${i}`) || !acct[`d${i}`]) {
        if (!d.optional) missing.push(d.name);
      } else out[i] = acct[`d${i}`] ?? [];
    });
    rateLimited = (body?.errors ?? []).some((e) => RATE_LIMITED.test(e.message));
    return { rows: out, rateLimited };
  }
  if ((body?.errors ?? []).some((e) => RATE_LIMITED.test(e.message))) {
    for (const d of DATASETS) missing.push(d.name);
    return { rows: out, rateLimited: true };
  }
  await Promise.all(
    DATASETS.map(async (d, i) => {
      const one = await run(ask(field(d, i)));
      const rows = one?.data?.viewer?.accounts?.[0]?.[`d${i}`];
      if (rows) out[i] = rows;
      else {
        if (!d.optional) missing.push(d.name);
        if ((one?.errors ?? []).some((e) => RATE_LIMITED.test(e.message))) rateLimited = true;
      }
    }),
  );
  return { rows: out, rateLimited };
}

// ---------- Resource lists ----------

interface Inventory {
  resources: Map<string, Resource>;
  /** Analytics key (id without dashes, or name) → resource id, per product. */
  byKey: Map<string, string>;
  /** Products whose list loaded, so a resource missing from it is really gone. */
  listed: Set<ProductId>;
}

/**
 * What the Worker remembers of each listed resource (KV `seen:v1:<account>`): the last day it was
 * in its list and its analytics keys, so a deleted D1 database keeps its name and a date.
 */
export type Seen = Record<string, { d: string; k: string[] }>;

/** Products nothing runs without a binding to: listed but unbound reads as unused. */
const BINDABLE = new Set<ProductId>(['kv', 'd1', 'r2', 'queues', 'hyperdrive', 'vectorize']);

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
  const inv: Inventory = { resources: new Map(), byKey: new Map(), listed: new Set() };
  const a = `/accounts/${acct}`;
  const tryList = async <T>(label: string, fn: () => Promise<T[]>, product?: ProductId): Promise<T[]> => {
    try {
      const xs = await fn();
      if (product) inv.listed.add(product);
      return xs;
    } catch (e) {
      if (e instanceof CfError && e.code !== undefined && NOT_ENABLED.has(e.code)) {
        if (product) inv.listed.add(product);
        return [];
      }
      missing.push(label);
      return [];
    }
  };
  const [allScripts, domains, kvs, d1s, r2, dos, queues, workflows, hyper, vec] = await Promise.all([
    tryList('Workers scripts', () => restList<{ id: string }>(token, `${a}/workers/scripts`), 'workers'),
    tryList('Workers custom domains', () =>
      restList<{ hostname: string; service: string }>(token, `${a}/workers/domains`),
    ),
    tryList(
      'KV namespaces',
      () => restList<{ id: string; title: string }>(token, `${a}/storage/kv/namespaces`),
      'kv',
    ),
    tryList('D1 databases', () => restList<{ uuid: string; name: string }>(token, `${a}/d1/database`), 'd1'),
    tryList(
      'R2 buckets',
      async () =>
        (
          await rest<{ buckets: { name: string; storage_class?: string }[] }>(
            token,
            `${a}/r2/buckets?per_page=1000`,
          )
        ).buckets ?? [],
      'r2',
    ),
    tryList(
      'Durable Objects namespaces',
      () =>
        restList<{ id: string; name: string; class: string; script: string; use_sqlite?: boolean }>(
          token,
          `${a}/workers/durable_objects/namespaces`,
        ),
      'do',
    ),
    tryList(
      'Queues',
      () => restList<{ queue_id: string; queue_name: string }>(token, `${a}/queues`),
      'queues',
    ),
    tryList('Workflows', () => restList<{ id: string; name: string }>(token, `${a}/workflows`), 'workflows'),
    tryList(
      'Hyperdrive configs',
      () => restList<{ id: string; name: string }>(token, `${a}/hyperdrive/configs`),
      'hyperdrive',
    ),
    tryList(
      'Vectorize indexes',
      () => rest<{ name: string; config?: { dimensions?: number } }[]>(token, `${a}/vectorize/v2/indexes`),
      'vectorize',
    ),
  ]);

  // Some lists ignore paging and answer every page in full: keep each script once.
  const scripts = [...new Map(allScripts.map((x) => [x.id, x])).values()];
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
  // Unbound is only said when every Worker's bindings were read.
  let bindsKnown = inv.listed.has('workers') && scripts.length <= 60;
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
        bindsKnown = false;
      }
      add(inv, acct, 'workers', s.id, [s.id], { routes: routes.get(s.id), binds: [...new Set(binds)] });
    }),
  );
  if (scripts.length > 60) missing.push(`Bindings for ${scripts.length - 60} more Workers`);
  // Past the cap a Worker still counts as listed, just without its bindings.
  for (const s of scripts.slice(60)) add(inv, acct, 'workers', s.id, [s.id], { routes: routes.get(s.id) });
  if (bindsKnown) {
    const bound = new Set([...inv.resources.values()].flatMap((r) => r.binds ?? []));
    for (const r of inv.resources.values())
      if (BINDABLE.has(r.product) && !bound.has(r.id)) r.state = 'unbound';
  }
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

// ---------- Billed usage ----------

/** Cloudflare's service names (`Workers Standard`, `R2 Storage Class A Operations`) to products. */
const SERVICE_PRODUCT: [RegExp, ProductId][] = [
  [/durable object/i, 'do'],
  [/workers ai|neuron/i, 'ai'],
  [/workers kv|\bkv\b/i, 'kv'],
  [/\bd1\b/i, 'd1'],
  [/data catalog|pipelines|r2 sql/i, 'basin'],
  [/\br2\b/i, 'r2'],
  [/vectorize/i, 'vectorize'],
  [/queue/i, 'queues'],
  [/hyperdrive/i, 'hyperdrive'],
  [/container/i, 'containers'],
  [/workflow/i, 'workflows'],
  [/build/i, 'builds'],
  [/workers/i, 'workers'],
];

type BillRow = {
  ServiceName?: string;
  ServiceFamilyName?: string;
  ChargeDescription?: string | null;
  ChargePeriodEnd?: string;
  BilledCost?: number;
  ContractedCost?: number;
  BillingCurrency?: string;
};

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * This billing period's usage charges from the Billable Usage API (needs Billing Read). The period
 * starts on the subscription's anchor day, which the query range must include.
 */
async function readBilling(token: string, acct: string, now = new Date()): Promise<Account['billing']> {
  let info: {
    covered?: boolean;
    subscriptions?: { billing_cycle_anchor_timestamp?: string; end_timestamp?: string }[];
  };
  try {
    info = await rest(token, `/accounts/${acct}/billable-usage/info`);
  } catch (e) {
    return e instanceof CfError && (e.status === 401 || e.status === 403) ? 'no-access' : undefined;
  }
  if (!info.covered) return 'not-covered';
  const anchor = info.subscriptions?.find((s) => !s.end_timestamp)?.billing_cycle_anchor_timestamp;
  const anchorDay = anchor ? new Date(anchor).getUTCDate() : 1;
  // The anchor day in a given month, or that month's last day when it's shorter.
  const start = (y: number, mo: number) =>
    Date.UTC(y, mo, Math.min(anchorDay, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()));
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const from = now.getTime() >= start(y, mo) ? start(y, mo) : start(y, mo - 1);
  try {
    const rows = await rest<BillRow[]>(
      token,
      `/accounts/${acct}/billable-usage?from=${isoDay(from)}&to=${isoDay(now.getTime())}`,
    );
    const lines = new Map<string, Billed['lines'][number]>();
    let end = 0;
    let currency = 'USD';
    for (const r of rows ?? []) {
      const service = r.ServiceName || r.ServiceFamilyName || 'Other';
      const name = `${service} ${r.ServiceFamilyName ?? ''} ${r.ChargeDescription ?? ''}`;
      const line = lines.get(service) ?? {
        service,
        product: SERVICE_PRODUCT.find(([re]) => re.test(name))?.[1] ?? null,
        cost: 0,
      };
      line.cost += r.BilledCost ?? r.ContractedCost ?? 0;
      lines.set(service, line);
      if (r.ChargePeriodEnd) end = Math.max(end, Date.parse(r.ChargePeriodEnd));
      if (r.BillingCurrency) currency = r.BillingCurrency;
    }
    return {
      from: isoDay(from),
      // A charge period ends at 00:00 the next day: the last billed day is the one before.
      through: end ? isoDay(end - 1) : null,
      currency,
      lines: [...lines.values()].sort((p, q) => q.cost - p.cost),
    };
  } catch (e) {
    return e instanceof CfError && (e.status === 401 || e.status === 403) ? 'no-access' : undefined;
  }
}

// ---------- One account ----------

export async function readAccount(
  token: string,
  meta: { id: string; name: string; token: string; tokenLabel: string; planOverride?: Plan },
  dates: string[],
  /** What the Worker remembers from earlier reads, and the resource ids labels point at. */
  memory: { seen: Seen; labelled: string[] } = { seen: {}, labelled: [] },
): Promise<{ account: Account; resources: Resource[]; rateLimited: boolean; seen: Seen }> {
  const missing: string[] = [];
  const [inv, detected, { rows, rateLimited }, billing] = await Promise.all([
    inventory(token, meta.id, missing),
    meta.planOverride ? Promise.resolve(null) : detectPlan(token, meta.id),
    fetchDatasets(token, meta.id, dates, missing),
    readBilling(token, meta.id),
  ]);
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const today = dates.at(-1) ?? '';

  // Remember every listed resource as seen today, with the keys its analytics use.
  const seen: Seen = { ...memory.seen };
  const keysOf = new Map<string, string[]>();
  for (const [k, id] of inv.byKey) keysOf.set(id, [...(keysOf.get(id) ?? []), k.slice(k.indexOf('|') + 1)]);
  for (const r of inv.resources.values()) seen[r.id] = { d: today, k: keysOf.get(r.id) ?? [] };
  const gone = (id: string, product: ProductId) =>
    id.startsWith(`${meta.id}:`) && inv.listed.has(product) && !inv.resources.has(id);
  const nameOf = (id: string) => id.split(':').slice(2).join(':');
  for (const [id, s] of Object.entries(memory.seen)) {
    const product = id.split(':')[1] as ProductId;
    // A key a listed resource still answers to means it was renamed, not deleted.
    if (!gone(id, product) || s.k.some((k) => inv.byKey.has(`${product}|${k}`))) continue;
    add(inv, meta.id, product, nameOf(id), s.k, { state: 'deleted', lastSeen: s.d });
  }

  DATASETS.forEach((d, i) => {
    for (const row of rows[i] ?? []) {
      const day = dayIndex.get(row.dimensions.date ?? '');
      const key = d.key(row);
      if (day === undefined || key === null) continue;
      let id = inv.byKey.get(`${d.product}|${key}`);
      if (!id && key && key !== '*' && key !== '__unknown__' && inv.listed.has(d.product)) {
        // Usage for a resource its list no longer has: deleted.
        id = add(inv, meta.id, d.product, key, [key], { state: 'deleted' });
      }
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
                  d.product === 'ai'
                    ? key
                    : d.product === 'basin'
                      ? 'Data Catalog warehouse'
                      : 'Not in the account’s list: deleted, or the token can’t list it',
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

  // Labels on resources that are gone and left nothing else behind still show, as deleted.
  for (const id of memory.labelled) {
    const product = id.split(':')[1] as ProductId;
    const renamed = memory.seen[id]?.k.some((k) => inv.byKey.has(`${product}|${k}`));
    if (gone(id, product) && !renamed) add(inv, meta.id, product, nameOf(id), [], { state: 'deleted' });
  }
  // A deleted resource never remembered was last seen on its last day with usage.
  for (const r of inv.resources.values()) {
    if (r.state !== 'deleted' || r.lastSeen) continue;
    let last = -1;
    for (const s of Object.values(r.series))
      for (let i = s.length - 1; i > last; i--)
        if ((s[i] ?? 0) > 0) {
          last = i;
          break;
        }
    if (last >= 0) r.lastSeen = dates[last];
  }

  // An Infrequent Access bucket's numbers count against the IA allowance and prices. R2's analytics
  // don't split by storage class, so the bucket's default class decides.
  for (const r of inv.resources.values()) {
    if (r.product !== 'r2' || r.type !== 'Infrequent Access') continue;
    for (const k of ['stor', 'a', 'b']) {
      const s = r.series[`r2.${k}`];
      if (!s) continue;
      r.series[`r2.ia.${k}`] = s;
      delete r.series[`r2.${k}`];
    }
  }

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
      billing,
    },
    resources: [...inv.resources.values()].sort((x, y) => x.name.localeCompare(y.name)),
    /** Cloudflare's analytics budget ran out mid-read: the caller keeps its last good copy. */
    rateLimited,
    seen,
  };
}

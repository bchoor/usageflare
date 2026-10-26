/**
 * Cloudflare products, the metrics usageflare tracks for each and their plan allowances, grouped the
 * way the Cloudflare dashboard groups them. Shared by the Worker (what to fetch) and the UI (how to
 * judge it). Allowances and prices are Workers Free / Workers Paid list prices.
 */

export type CategoryId = 'compute' | 'storage' | 'ai' | 'messaging';
export type ProductId =
  | 'workers'
  | 'workflows'
  | 'containers'
  | 'do'
  | 'builds'
  | 'kv'
  | 'd1'
  | 'r2'
  | 'hyperdrive'
  | 'ai'
  | 'vectorize'
  | 'queues'
  | 'basin';

export interface Category {
  id: CategoryId;
  label: string;
  color: string;
}

export interface Product {
  id: ProductId;
  cat: CategoryId;
  label: string;
  color: string;
  /** The GraphQL datasets or REST endpoint its numbers come from (shown in the drawer). */
  source: string;
}

/**
 * `[included amount, period, USD per unit beyond it]`. A Free allowance without a price is a hard
 * limit; R2 bills beyond its free tier on either plan.
 */
export type Allowance = [number, 'day' | 'mo', number?];

/**
 * Metric families: every product maps its metrics onto the same columns, so products in one
 * category line up (R2 Class A ops count as writes, Class B as reads; build minutes and CPU as
 * compute time).
 */
export const FAMILIES = [
  { id: 'req', label: 'Requests', color: '#3b82f6' },
  { id: 'q', label: 'Queries', color: '#06b6d4' },
  { id: 'ops', label: 'Operations', color: '#84cc16' },
  { id: 'units', label: 'Inference', color: '#8b5cf6' },
  { id: 'cpu', label: 'Compute time', color: '#f97316' },
  { id: 'mem', label: 'Memory · duration', color: '#eab308' },
  { id: 'read', label: 'Reads', color: '#14b8a6' },
  { id: 'write', label: 'Writes', color: '#a855f7' },
  { id: 'stor', label: 'Stored', color: '#22c55e' },
] as const;
export type FamilyId = (typeof FAMILIES)[number]['id'];
export const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.id, f])) as Record<
  FamilyId,
  (typeof FAMILIES)[number]
>;

export interface Metric {
  key: string;
  family: FamilyId;
  product: ProductId;
  label: string;
  unit: '' | 'ms' | 'GB' | 'GB-s' | 'GB-h' | 'GiB-h' | 'vCPU-min' | 'min';
  /** `sum`: a count per day; `gauge`: a size at a point in time (latest day counts). */
  kind: 'sum' | 'gauge';
  /** A storage tier with its own allowance (R2 Infrequent Access); its label ends `· IA`. */
  tier?: string;
  /** Billed, but Cloudflare offers no usage API for it: shown as "No usage API", never 0. */
  noApi?: boolean;
  paid: Allowance | null;
  free: Allowance | null;
}

export const CATEGORIES: Category[] = [
  { id: 'compute', label: 'Compute', color: '#f38020' },
  { id: 'storage', label: 'Storage & databases', color: '#1c7ed6' },
  { id: 'ai', label: 'AI', color: '#7048e8' },
  { id: 'messaging', label: 'Messaging', color: '#37b24d' },
];

export const PRODUCTS: Product[] = [
  { id: 'workers', cat: 'compute', label: 'Workers', color: '#f38020', source: 'workersInvocationsAdaptive' },
  {
    id: 'workflows',
    cat: 'compute',
    label: 'Workflows',
    color: '#d9480f',
    source: 'workflowsAdaptiveGroups',
  },
  {
    id: 'containers',
    cat: 'compute',
    label: 'Containers',
    color: '#c2255c',
    source: 'containersMetricsAdaptiveGroups',
  },
  {
    id: 'do',
    cat: 'compute',
    label: 'Durable Objects',
    color: '#e64980',
    source:
      'durableObjectsInvocationsAdaptiveGroups · durableObjectsPeriodicGroups · durableObjectsStorageGroups',
  },
  {
    id: 'builds',
    cat: 'compute',
    label: 'Workers Builds',
    color: '#e8a200',
    source: 'workersBuildsBuildMinutesAdaptiveGroups',
  },
  {
    id: 'kv',
    cat: 'storage',
    label: 'Workers KV',
    color: '#1c7ed6',
    source: 'kvOperationsAdaptiveGroups · kvStorageAdaptiveGroups',
  },
  {
    id: 'd1',
    cat: 'storage',
    label: 'D1',
    color: '#4263eb',
    source: 'd1AnalyticsAdaptiveGroups · d1StorageAdaptiveGroups',
  },
  {
    id: 'r2',
    cat: 'storage',
    label: 'R2',
    color: '#0ca678',
    source: 'r2OperationsAdaptiveGroups · r2StorageAdaptiveGroups',
  },
  {
    id: 'hyperdrive',
    cat: 'storage',
    label: 'Hyperdrive',
    color: '#1098ad',
    source: 'hyperdriveQueriesAdaptiveGroups',
  },
  { id: 'ai', cat: 'ai', label: 'Workers AI', color: '#7048e8', source: 'aiInferenceAdaptiveGroups' },
  {
    id: 'vectorize',
    cat: 'ai',
    label: 'Vectorize',
    color: '#ae3ec9',
    source: 'vectorizeV2QueriesAdaptiveGroups · vectorizeV2StorageAdaptiveGroups',
  },
  {
    id: 'basin',
    cat: 'storage',
    label: 'R2 Data Catalog',
    color: '#087f5b',
    source: 'r2CatalogDataOperationsAdaptiveGroups (R2 SQL has no usage API)',
  },
  {
    id: 'queues',
    cat: 'messaging',
    label: 'Queues',
    color: '#37b24d',
    source: 'queueMessageOperationsAdaptiveGroups',
  },
];

export const METRICS: Metric[] = [
  {
    key: 'workers.req',
    family: 'req',
    product: 'workers',
    label: 'Requests',
    unit: '',
    kind: 'sum',
    paid: [10e6, 'mo', 0.3 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'workers.cpu',
    family: 'cpu',
    product: 'workers',
    label: 'CPU time',
    unit: 'ms',
    kind: 'sum',
    paid: [30e6, 'mo', 0.02 / 1e6],
    free: null,
  },
  {
    key: 'kv.read',
    family: 'read',
    product: 'kv',
    label: 'Reads',
    unit: '',
    kind: 'sum',
    paid: [10e6, 'mo', 0.5 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'kv.write',
    family: 'write',
    product: 'kv',
    label: 'Writes',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 5 / 1e6],
    free: [1e3, 'day'],
  },
  {
    key: 'kv.delete',
    family: 'ops',
    product: 'kv',
    label: 'Deletes',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 5 / 1e6],
    free: [1e3, 'day'],
  },
  {
    key: 'kv.list',
    family: 'ops',
    product: 'kv',
    label: 'Lists',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 5 / 1e6],
    free: [1e3, 'day'],
  },
  {
    key: 'kv.stor',
    family: 'stor',
    product: 'kv',
    label: 'Stored data',
    unit: 'GB',
    kind: 'gauge',
    paid: [1, 'mo', 0.5],
    free: [1, 'mo'],
  },
  {
    key: 'd1.read',
    family: 'read',
    product: 'd1',
    label: 'Rows read',
    unit: '',
    kind: 'sum',
    paid: [25e9, 'mo', 0.001 / 1e6],
    free: [5e6, 'day'],
  },
  {
    key: 'd1.write',
    family: 'write',
    product: 'd1',
    label: 'Rows written',
    unit: '',
    kind: 'sum',
    paid: [50e6, 'mo', 1 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'd1.stor',
    family: 'stor',
    product: 'd1',
    label: 'Storage',
    unit: 'GB',
    kind: 'gauge',
    paid: [5, 'mo', 0.75],
    free: [5, 'mo'],
  },
  {
    key: 'r2.stor',
    family: 'stor',
    product: 'r2',
    label: 'Storage',
    unit: 'GB',
    kind: 'gauge',
    paid: [10, 'mo', 0.015],
    free: [10, 'mo', 0.015],
  },
  {
    key: 'r2.a',
    family: 'write',
    product: 'r2',
    label: 'Class A ops',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 4.5 / 1e6],
    free: [1e6, 'mo', 4.5 / 1e6],
  },
  {
    key: 'r2.b',
    family: 'read',
    product: 'r2',
    label: 'Class B ops',
    unit: '',
    kind: 'sum',
    paid: [10e6, 'mo', 0.36 / 1e6],
    free: [10e6, 'mo', 0.36 / 1e6],
  },
  // Infrequent Access buckets: no free tier, so every unit is billed (pay as you go).
  {
    key: 'r2.ia.stor',
    family: 'stor',
    product: 'r2',
    label: 'Storage · IA',
    tier: 'Infrequent Access',
    unit: 'GB',
    kind: 'gauge',
    paid: [0, 'mo', 0.01],
    free: [0, 'mo', 0.01],
  },
  {
    key: 'r2.ia.a',
    family: 'write',
    product: 'r2',
    label: 'Class A ops · IA',
    tier: 'Infrequent Access',
    unit: '',
    kind: 'sum',
    paid: [0, 'mo', 9 / 1e6],
    free: [0, 'mo', 9 / 1e6],
  },
  {
    key: 'r2.ia.b',
    family: 'read',
    product: 'r2',
    label: 'Class B ops · IA',
    tier: 'Infrequent Access',
    unit: '',
    kind: 'sum',
    paid: [0, 'mo', 0.9 / 1e6],
    free: [0, 'mo', 0.9 / 1e6],
  },
  // Basin: R2 Data Catalog (Iceberg) and R2 SQL, on every plan.
  {
    key: 'basin.ops',
    family: 'ops',
    product: 'basin',
    label: 'Catalog operations',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 9 / 1e6],
    free: [1e6, 'mo', 9 / 1e6],
  },
  {
    key: 'basin.scan',
    family: 'read',
    product: 'basin',
    label: 'R2 SQL data scanned',
    unit: 'GB',
    kind: 'sum',
    noApi: true,
    paid: [10, 'mo', 0.0025],
    free: [10, 'mo', 0.0025],
  },
  {
    key: 'do.req',
    family: 'req',
    product: 'do',
    label: 'Requests',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 0.15 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'do.dur',
    family: 'mem',
    product: 'do',
    label: 'Duration',
    unit: 'GB-s',
    kind: 'sum',
    paid: [4e5, 'mo', 12.5 / 1e6],
    free: [13e3, 'day'],
  },
  {
    key: 'do.rowsr',
    family: 'read',
    product: 'do',
    label: 'Rows read',
    unit: '',
    kind: 'sum',
    paid: [25e9, 'mo', 0.001 / 1e6],
    free: [5e6, 'day'],
  },
  {
    key: 'do.rowsw',
    family: 'write',
    product: 'do',
    label: 'Rows written',
    unit: '',
    kind: 'sum',
    paid: [50e6, 'mo', 1 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'do.stor',
    family: 'stor',
    product: 'do',
    label: 'Stored data',
    unit: 'GB',
    kind: 'gauge',
    paid: [5, 'mo', 0.2],
    free: [5, 'mo'],
  },
  {
    key: 'wf.req',
    family: 'req',
    product: 'workflows',
    label: 'Instances started',
    unit: '',
    kind: 'sum',
    paid: [10e6, 'mo', 0.3 / 1e6],
    free: [1e5, 'day'],
  },
  {
    key: 'ct.cpu',
    family: 'cpu',
    product: 'containers',
    label: 'vCPU time',
    unit: 'vCPU-min',
    kind: 'sum',
    paid: [375, 'mo', 0.0012],
    free: null,
  },
  {
    key: 'ct.mem',
    family: 'mem',
    product: 'containers',
    label: 'Memory',
    unit: 'GiB-h',
    kind: 'sum',
    paid: [25, 'mo', 0.009],
    free: null,
  },
  {
    key: 'ct.disk',
    family: 'stor',
    product: 'containers',
    label: 'Disk',
    unit: 'GB-h',
    kind: 'sum',
    paid: [200, 'mo', 0.000252],
    free: null,
  },
  {
    key: 'hd.q',
    family: 'q',
    product: 'hyperdrive',
    label: 'Queries',
    unit: '',
    kind: 'sum',
    paid: null,
    free: [1e5, 'day'],
  },
  {
    key: 'ai.neurons',
    family: 'units',
    product: 'ai',
    label: 'Neurons',
    unit: '',
    kind: 'sum',
    paid: [1e4, 'day', 0.011 / 1000],
    free: [1e4, 'day'],
  },
  {
    key: 'vec.q',
    family: 'q',
    product: 'vectorize',
    label: 'Queried dimensions',
    unit: '',
    kind: 'sum',
    paid: [50e6, 'mo', 0.01 / 1e6],
    free: [30e6, 'mo'],
  },
  {
    key: 'vec.stor',
    family: 'stor',
    product: 'vectorize',
    label: 'Stored dimensions',
    unit: '',
    kind: 'gauge',
    paid: [10e6, 'mo', 0.05 / 1e8],
    free: [5e6, 'mo'],
  },
  {
    key: 'queues.ops',
    family: 'ops',
    product: 'queues',
    label: 'Operations',
    unit: '',
    kind: 'sum',
    paid: [1e6, 'mo', 0.4 / 1e6],
    free: [1e4, 'day'],
  },
  {
    key: 'builds.min',
    family: 'cpu',
    product: 'builds',
    label: 'Build minutes',
    unit: 'min',
    kind: 'sum',
    paid: [6000, 'mo', 0.005],
    free: [3000, 'mo'],
  },
];

export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<CategoryId, Category>;
export const PRODUCT = Object.fromEntries(PRODUCTS.map((p) => [p.id, p])) as Record<ProductId, Product>;
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<string, Metric>;

/** Days of history every series holds, oldest first, ending today (UTC). */
export const HISTORY_DAYS = 31;

/** Hourly slots every `Resource.hourly` holds: the last 24 whole hours and the current one. */
export const HOURLY_SLOTS = 25;

export type Plan = 'free' | 'paid';

export interface Account {
  /** Cloudflare account ID. */
  id: string;
  name: string;
  plan: Plan;
  /**
   * `detected` from the account's subscriptions, `set` in Settings, `inferred` (Paid) from usage a
   * Free account couldn't have, or `assumed` (Free) without any of those.
   */
  planSource: 'detected' | 'set' | 'inferred' | 'assumed';
  /** The Settings token (its KV name) this account is read with. */
  token: string;
  tokenLabel: string;
  syncedAt: string;
  /** Datasets or lists the token couldn't read, e.g. `R2 buckets` or `d1AnalyticsAdaptiveGroups`. */
  missing: string[];
  /**
   * What Cloudflare has billed this period (its Billable Usage API): `no-access` without Billing
   * Read, `not-covered` where Cloudflare doesn't report it (Enterprise, for now). Optional: a token
   * without Billing Read keeps the estimates alone.
   */
  billing?: Billed | 'no-access' | 'not-covered';
  /**
   * Start of the first `Resource.hourly` slot (ISO, on the hour, UTC). Absent when the hourly read
   * failed: pace then falls back to the daily series.
   */
  hoursFrom?: string;
  /** Products whose counted meters were read by the hour; the rest (Builds, a refused dataset) pace by day. */
  hourly?: ProductId[];
}

/** One account's billed usage this billing period, per Cloudflare service. */
export interface Billed {
  /** First day of the billing period (`YYYY-MM-DD`), from the subscription's anchor day. */
  from: string;
  /** Last day Cloudflare has billed so far (`YYYY-MM-DD`); null before the first daily row. */
  through: string | null;
  currency: string;
  /** Usage charges only: the plan's base fee isn't in them. */
  lines: { service: string; product: ProductId | null; cost: number }[];
}

export interface Resource {
  /** `<account>:<product>:<name>`. */
  id: string;
  acct: string;
  product: ProductId;
  name: string;
  /** Storage class, backend or instance type. */
  type?: string;
  /** Cloudflare's own id for it, as its Tagging API names it (a Worker's script tag, a bucket's name). */
  cfId?: string;
  /** Custom domains or routes, for Workers. */
  routes?: string[];
  /** What a Worker binds to, as resource ids. */
  binds?: string[];
  /** e.g. Vectorize dimensions or a model id. */
  detail?: string;
  /** True for the account-wide row of a metric Cloudflare doesn't split by resource. */
  total?: boolean;
  /**
   * `deleted`: in analytics, tags or the Worker's memory, but gone from its product's list (only
   * set when that list loaded). `unbound`: listed, but no Worker binds it. Left out: live.
   */
  state?: 'deleted' | 'unbound';
  /** A deleted resource's last day in its list (or with usage), `YYYY-MM-DD`. */
  lastSeen?: string;
  /** Daily values, `HISTORY_DAYS` long, per metric key. */
  series: Record<string, number[]>;
  /**
   * Hourly values for the pace windows, `HOURLY_SLOTS` long from `Account.hoursFrom`, per metric key
   * (counted metrics only; the last slot is the hour in progress).
   */
  hourly?: Record<string, number[]>;
}

export interface UsageSnapshot {
  /** Dates of the series, `YYYY-MM-DD`, oldest first. */
  dates: string[];
  accounts: Account[];
  resources: Resource[];
  /** Tokens that couldn't be used at all. */
  errors: { token: string; label: string; error: string }[];
}

export interface Tag {
  /** The account it belongs to: each account keeps its own tags; one name in two accounts is two tags. */
  acct: string;
  /** A project tag's name (`mailcellar`, its key in Cloudflare `project.mailcellar`), or `key=value` for any other Cloudflare tag. */
  name: string;
  /** Index into the tag palette. */
  c: number;
  icon?: string;
}

export interface TagsDoc {
  tags: Tag[];
  /** resource id → tag names (of the resource's own account). */
  assign: Record<string, string[]>;
}

/**
 * What `/api/tags` answers: the tags and who has them, from Cloudflare where an account has a tags
 * token, else as kept in usageflare.
 */
export interface TagsState extends TagsDoc {
  /** resource id → tag names kept only in usageflare (Cloudflare can't tag it, or no tags token yet). */
  local: Record<string, string[]>;
  /** account id → whether a tags token reaches it, and why not when one was tried. */
  access: Record<string, { write: boolean; error?: string }>;
  /** When Cloudflare's tags were read (ISO); absent when no account has a tags token. */
  readAt?: string;
  /** Resources Cloudflare refused a write for, with why (a 412 means it changed there: read again). */
  failed?: { id: string; error: string }[];
  /** Writes still to do: the client sends the same doc again until this is 0. */
  left?: number;
}

/** Cloudflare's Tagging API resource type per product; the rest can't be tagged there yet. */
export const CF_TAG_TYPE: Partial<Record<ProductId, string>> = {
  workers: 'worker',
  kv: 'kv_namespace',
  d1: 'd1_database',
  r2: 'r2_bucket',
  do: 'durable_object_namespace',
  queues: 'queue',
  vectorize: 'vectorize_index',
};

/** The account a resource id (`<account>:<product>:<name>`) belongs to. */
export const acctOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(':')));

/** A project tag `mailcellar` is the key `project.mailcellar` (no value); others are `key=value`. */
export const PROJECT_PREFIX = 'project.';
export function tagToCf(name: string): [string, string] {
  const i = name.indexOf('=');
  return i < 0 ? [PROJECT_PREFIX + name, ''] : [name.slice(0, i), name.slice(i + 1)];
}
export function tagFromCf(key: string, value: string): string {
  return key.startsWith(PROJECT_PREFIX) && !value ? key.slice(PROJECT_PREFIX.length) : `${key}=${value}`;
}

export interface Prefs {
  /** Percent of an allowance at which a metric shows as Watch. */
  warn: number;
  /** Per-account plan override. */
  plans: Record<string, Plan>;
}

/**
 * The token permission each thing the Worker reads needs, by the name it reports when it can't
 * (`Account.missing`); analytics datasets also need Account Analytics: Read.
 */
const PERMISSION_BY_PREFIX: [RegExp, string][] = [
  [/^Workers Builds/, 'Workers CI'],
  [/^Workers AI/, 'Workers AI'],
  [/^(Workers|Durable Objects|Workflows|Bindings)/, 'Workers Scripts'],
  [/^KV/, 'Workers KV Storage'],
  [/^D1/, 'D1'],
  [/^R2/, 'Workers R2 Storage'],
  [/^Queues/, 'Queues'],
  [/^Hyperdrive/, 'Hyperdrive'],
  [/^Vectorize/, 'Vectorize'],
  [/^Containers/, 'Workers Containers'],
];
export function permissionsFor(missing: string[]): string[] {
  const out = new Set<string>();
  for (const m of missing) {
    const hit = PERMISSION_BY_PREFIX.find(([re]) => re.test(m));
    if (hit) out.add(`Account › ${hit[1]} › Read`);
  }
  return [...out].sort();
}

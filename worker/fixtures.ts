/**
 * Sample data for local work: three accounts with Workers, storage, AI and queues, so every page
 * renders without a Cloudflare token. On only when `FIXTURES=1` (in `.dev.vars`) and the request
 * is to localhost; a deployed Worker never serves it.
 */
import {
  type Account,
  type Billed,
  HOURLY_SLOTS,
  type ProductId,
  type Resource,
  type Tag,
  type TagsState,
} from '../shared/catalog';
import { hoursFrom } from './cloudflare';
import type { Env } from './env';

const ACCOUNTS = [
  { id: 'a1000000000000000000000000000001', name: 'Personal', plan: 'paid' as const },
  { id: 'a2000000000000000000000000000002', name: 'Icaruslab Dev', plan: 'free' as const },
  { id: 'a3000000000000000000000000000003', name: 'Icaruslab Prod', plan: 'paid' as const },
];

export const fixturesOn = (env: Env, url: string) => {
  const host = new URL(url).hostname;
  return env.FIXTURES === '1' && (host === 'localhost' || host === '127.0.0.1');
};

/** A steady, seeded daily series around `base` with a gentle rise and weekly dip. */
function series(seed: number, base: number, days: number, gauge = false): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return Array.from({ length: days }, (_, i) => {
    const trend = 0.7 + (0.6 * i) / days;
    const weekly = gauge ? 1 : i % 7 === 5 || i % 7 === 6 ? 0.6 : 1;
    return Math.round(base * trend * weekly * (gauge ? 1 : 0.8 + 0.4 * rnd()) * 1000) / 1000;
  });
}

const DEV = 'a2000000000000000000000000000002';
const PROD = 'a3000000000000000000000000000003';

/** The last item, for a deleted resource: how many days ago it was last seen. */
type Spec = [ProductId, string, Record<string, number>, Partial<Resource>?, number?];

/** Per account: product, name, daily base per metric (gauges are sizes), extras. */
const SPECS: Record<string, Spec[]> = {
  a1000000000000000000000000000001: [
    [
      'workers',
      'photo-backup',
      { 'workers.req': 90e3, 'workers.cpu': 260e3 },
      { routes: ['backup.example.dev'] },
    ],
    ['workers', 'blog-site', { 'workers.req': 21e3, 'workers.cpu': 60e3 }],
    ['workers', 'newsletter-api', { 'workers.req': 130e3, 'workers.cpu': 420e3 }],
    ['workers', 'status-page-proxy', { 'workers.req': 45e3, 'workers.cpu': 120e3 }],
    ['kv', 'SESSIONS', { 'kv.read': 150e3, 'kv.write': 18e3, 'kv.stor': 0.4 }],
    ['kv', 'CONFIG', { 'kv.read': 30e3, 'kv.write': 40, 'kv.stor': 0.01 }],
    ['kv', 'API_KEYS_PREVIEW', {}, { state: 'unbound' }],
    ['r2', 'newsletter-spike', { 'r2.stor': 0.4, 'r2.a': 900, 'r2.b': 2e3 }, { state: 'deleted' }, 13],
    ['d1', '86c1c9e9e1a54d0c9b0f3f6f4b7a2c11', { 'd1.read': 2e5, 'd1.write': 900 }, { state: 'deleted' }, 40],
    ['d1', 'newsletter-db', { 'd1.read': 40e6, 'd1.write': 600e3, 'd1.stor': 2.1 }],
    ['r2', 'backups', { 'r2.stor': 6.2, 'r2.a': 52e3, 'r2.b': 120e3 }, { type: 'Standard' }],
    // A bucket with a handful of operations in an account whose Class A pool is over: no "At cap".
    ['r2', 'upload-inbox', { 'r2.stor': 1e-6, 'r2.a': 0.12 }, { type: 'Standard' }],
    [
      'r2',
      'backups-archive',
      { 'r2.ia.stor': 2.4, 'r2.ia.a': 400, 'r2.ia.b': 900 },
      { type: 'Infrequent Access' },
    ],
    ['basin', 'events-warehouse', { 'basin.ops': 9e3 }, { detail: 'Data Catalog warehouse' }],
    [
      'do',
      'RateLimiter',
      { 'do.req': 22e3, 'do.dur': 9e3, 'do.rowsr': 1.2e6, 'do.rowsw': 90e3, 'do.stor': 0.3 },
      { type: 'SQLite', detail: '214 objects' },
    ],
    ['queues', 'mail-out', { 'queues.ops': 26e3 }],
    ['ai', '@cf/meta/llama-3.1-8b-instruct', { 'ai.neurons': 5.1e3 }],
    ['workflows', 'nightly-export', { 'wf.req': 1.2e3 }],
    ['builds', 'Workers Builds', { 'builds.min': 160 }, { total: true }],
    ['email', 'mail.example.dev', { 'email.sent': 85 }, { detail: 'Sending domain' }],
    ['realtime', 'Whole account', { 'rt.egress': 1.6 }, { total: true }],
  ],
  a2000000000000000000000000000002: [
    ['workers', 'quizgame-staging', { 'workers.req': 38e3, 'workers.cpu': 200e3 }],
    [
      'workers',
      'chatbot-dev',
      { 'workers.req': 14e3, 'workers.cpu': 90e3 },
      { binds: [`${DEV}:browser:chatbot-dev`] },
    ],
    ['browser', 'chatbot-dev', { 'br.hours': 0.11 }, { detail: 'Opened by Worker chatbot-dev' }],
    ['browser', 'Whole account', { 'br.conc': 2 }, { total: true }],
    ['kv', 'CACHE', { 'kv.read': 64e3, 'kv.write': 640, 'kv.stor': 0.2 }],
    ['d1', 'quizgame-dev', { 'd1.read': 3.1e6, 'd1.write': 45e3, 'd1.stor': 0.6 }],
    ['ai', '@cf/baai/bge-base-en-v1.5', { 'ai.neurons': 6.8e3 }],
    ['vectorize', 'docs-index', { 'vec.q': 300e3, 'vec.stor': 3.8e6 }, { detail: '768 dims' }],
    ['hyperdrive', 'pg-dev', { 'hd.q': 40e3 }],
  ],
  a3000000000000000000000000000003: [
    [
      'workers',
      'quizgame',
      { 'workers.req': 240e3, 'workers.cpu': 700e3 },
      { routes: ['quizgame.example.com'] },
    ],
    ['workers', 'admin', { 'workers.req': 30e3, 'workers.cpu': 90e3 }],
    [
      'workers',
      'storefront-web',
      { 'workers.req': 110e3, 'workers.cpu': 300e3 },
      { binds: [`${PROD}:browser:storefront-web`] },
    ],
    ['browser', 'storefront-web', { 'br.hours': 0.28 }, { detail: 'Opened by Worker storefront-web' }],
    ['browser', 'REST API', { 'br.hours': 0.05 }, { detail: 'Quick Actions called from outside a Worker' }],
    ['browser', 'Whole account', { 'br.conc': 7 }, { total: true }],
    ['images', 'Whole account', { 'img.tx': 190, 'img.del': 8e3, 'img.stor': 1800 }, { total: true }],
    ['stream', 'Whole account', { 'stream.del': 260, 'stream.stor': 420 }, { total: true }],
    ['logpush', 'Job 412', { 'logpush.rec': 220e3 }, { detail: 'Logpush job' }],
    ['zt', 'Whole account', { 'zt.seats': 12 }, { total: true }],
    [
      'containers',
      'renderer',
      { 'ct.cpu': 14, 'ct.mem': 0.9, 'ct.disk': 7 },
      { type: 'standard', detail: '3 instances' },
    ],
    ['kv', 'FLAGS', { 'kv.read': 300e3, 'kv.write': 2e3, 'kv.stor': 0.05 }],
    ['d1', 'quizgame-prod', { 'd1.read': 600e6, 'd1.write': 1.6e6, 'd1.stor': 4.4 }],
    ['r2', 'assets', { 'r2.stor': 8.7, 'r2.a': 34e3, 'r2.b': 410e3 }, { type: 'Standard' }],
    [
      'do',
      'Rooms',
      { 'do.req': 30e3, 'do.dur': 14e3, 'do.rowsr': 9e6, 'do.rowsw': 1.6e6, 'do.stor': 1.2 },
      { type: 'SQLite', detail: '1,904 objects' },
    ],
    ['queues', 'events', { 'queues.ops': 30e3 }],
    ['workflows', 'onboarding', { 'wf.req': 5e3 }],
  ],
};

/** Billed usage per account, USD this month to yesterday: Personal is off our estimate on D1. */
const BILLED: Record<string, [string, ProductId | null, number][] | 'no-access'> = {
  a1000000000000000000000000000001: [
    ['Workers Standard', 'workers', 0],
    ['D1 Rows Read', 'd1', 0.86],
    ['R2 Storage', 'r2', 0.12],
  ],
  a2000000000000000000000000000002: 'no-access',
  a3000000000000000000000000000003: [
    ['Workers Standard', 'workers', 0],
    ['D1 Rows Read', 'd1', 0],
    ['Images Transformations', 'images', 1.2],
  ],
};

function fixtureBilling(id: string, dates: string[]): Account['billing'] {
  const b = BILLED[id];
  if (!b || b === 'no-access') return b;
  const today = dates.at(-1) ?? '';
  return {
    from: `${today.slice(0, 8)}01`,
    // Billed to yesterday; on the 1st, nothing yet.
    through: today.endsWith('-01') ? null : (dates.at(-2) ?? null),
    currency: 'USD',
    lines: b.map(([service, product, cost]): Billed['lines'][number] => ({ service, product, cost })),
  };
}

/**
 * Hourly shapes that make pace worth looking at: Dev's staging Worker surging since the morning
 * (it hits the daily cap), and one lone hour of KV reads on Personal (damped, not projected).
 */
const SURGE: Record<string, (slot: number) => number> = {
  'a2000000000000000000000000000002:workers:quizgame-staging|workers.req': (h) => (h >= 17 ? 3.2 : 1),
  'a1000000000000000000000000000001:kv:SESSIONS|kv.read': (h) => (h === 20 ? 9 : 1),
  'a3000000000000000000000000000003:d1:quizgame-prod|d1.read': (h) => (h >= 12 ? 1.8 : 1),
};

/** The last day by the hour, from yesterday's total, with a daytime rise; today's day matches it. */
function withHourly(r: Resource, from: number, dates: string[]) {
  let s = r.id.length * 97;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const today = dates.length - 1;
  r.hourly = {};
  for (const [k, daily] of Object.entries(r.series)) {
    if (GAUGES.has(k)) continue;
    const perHour = (daily[today - 1] ?? 0) / 24;
    const surge = SURGE[`${r.id}|${k}`];
    const hours = Array.from({ length: HOURLY_SLOTS }, (_, h) => {
      const utc = new Date(from + h * 3_600_000).getUTCHours();
      const day = 0.7 + 0.6 * Math.max(0, Math.sin(((utc - 6) / 24) * 2 * Math.PI));
      return Math.round(perHour * day * (0.85 + 0.3 * rnd()) * (surge?.(h) ?? 1) * 100) / 100;
    });
    r.hourly[k] = hours;
    // Today so far is the hourly slots that fall on today's date.
    daily[today] = hours.reduce(
      (sum, v, h) =>
        new Date(from + h * 3_600_000).toISOString().startsWith(dates[today] ?? '') ? sum + v : sum,
      0,
    );
  }
}

const GAUGES = new Set([
  'kv.stor',
  'd1.stor',
  'r2.stor',
  'r2.ia.stor',
  'do.stor',
  'vec.stor',
  'br.conc',
  'img.stor',
  'stream.stor',
  'zt.seats',
]);

/** Counted in whole units: browsers, images, seats. */
const WHOLE = new Set(['br.conc', 'img.stor', 'zt.seats']);

export function fixtureRefs() {
  return {
    accounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name, token: 'sample', tokenLabel: 'Sample data' })),
    errors: [],
  };
}

export function fixtureUsage(accountId: string, dates: string[]) {
  const a = ACCOUNTS.find((x) => x.id === accountId);
  if (!a) return null;
  const account: Account = {
    id: a.id,
    name: a.name,
    plan: a.plan,
    planSource: 'detected',
    token: '',
    tokenLabel: 'Sample data',
    syncedAt: new Date().toISOString(),
    missing: a.plan === 'free' ? ['R2 buckets'] : [],
    unread: a.plan === 'free' ? ['Queues'] : undefined,
    billing: fixtureBilling(a.id, dates),
    hoursFrom: new Date(hoursFrom()).toISOString(),
    hourly: [
      'workers',
      'kv',
      'd1',
      'r2',
      'do',
      'workflows',
      'containers',
      'hyperdrive',
      'ai',
      'vectorize',
      'queues',
    ],
  };
  const resources: Resource[] = (SPECS[a.id] ?? []).map(([product, name, base, extra, ago], i) => {
    // A deleted resource's days after it was last seen are empty; past the window, all of them.
    const end = ago === undefined ? dates.length : Math.max(0, dates.length - ago);
    return {
      id: `${a.id}:${product}:${name}`,
      acct: a.id,
      product,
      name,
      ...extra,
      ...(ago !== undefined && end > 0 ? { lastSeen: dates[end - 1] } : {}),
      series: Object.fromEntries(
        Object.entries(base).map(([k, v], j) => [
          k,
          series(i * 31 + j + 7, v, dates.length, GAUGES.has(k)).map((x, d) =>
            d < end ? (WHOLE.has(k) ? Math.round(x) : x) : 0,
          ),
        ]),
      ),
    };
  });
  for (const r of resources) if (!r.lastSeen && r.state !== 'deleted') withHourly(r, hoursFrom(), dates);
  return { dates, account, resources, rateLimited: false };
}

/** Tags to start from, so the sidebar, filters and Tags settings have something to show. */
const FIXTURE_TAG_STYLE: Omit<Tag, 'acct'>[] = [
  { name: 'photo-backup', c: 1, icon: 'archive' },
  { name: 'blog', c: 2, icon: 'briefcase' },
  { name: 'status-page', c: 3, icon: 'zap' },
  { name: 'newsletter', c: 4, icon: 'mail' },
  { name: 'quizgame', c: 5, icon: 'gamepad-2' },
  { name: 'admin', c: 6, icon: 'wrench' },
  { name: 'storefront', c: 7, icon: 'flame' },
  { name: 'chatbot', c: 8, icon: 'bot' },
  { name: 'env=production', c: 9 },
];

const FIXTURE_ASSIGN: Record<string, string[]> = {
  'a1000000000000000000000000000001:workers:photo-backup': ['photo-backup'],
  'a1000000000000000000000000000001:r2:backups': ['photo-backup'],
  'a1000000000000000000000000000001:r2:backups-archive': ['photo-backup'],
  'a1000000000000000000000000000001:workers:blog-site': ['blog'],
  'a1000000000000000000000000000001:workers:status-page-proxy': ['status-page'],
  'a1000000000000000000000000000001:workers:newsletter-api': ['newsletter'],
  'a1000000000000000000000000000001:d1:newsletter-db': ['newsletter'],
  'a1000000000000000000000000000001:queues:mail-out': ['newsletter'],
  'a1000000000000000000000000000001:r2:newsletter-spike': ['newsletter'],
  'a2000000000000000000000000000002:workers:quizgame-staging': ['quizgame'],
  'a2000000000000000000000000000002:d1:quizgame-dev': ['quizgame'],
  'a2000000000000000000000000000002:workers:chatbot-dev': ['chatbot'],
  'a3000000000000000000000000000003:workers:quizgame': ['quizgame'],
  'a3000000000000000000000000000003:d1:quizgame-prod': ['quizgame'],
  'a3000000000000000000000000000003:do:Rooms': ['quizgame'],
  'a3000000000000000000000000000003:workers:admin': ['admin'],
  'a3000000000000000000000000000003:workers:storefront-web': ['storefront'],
  'a3000000000000000000000000000003:r2:assets': ['storefront'],
};

/**
 * Account 2's token can't write tags: its tags are kept in usageflare. Account 1 keeps a few here
 * too: one Cloudflare could hold, a Workflow it can't tag yet and a deleted bucket.
 */
const FIXTURE_LOCAL: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(FIXTURE_ASSIGN).filter(([id]) => id.startsWith('a2'))),
  'a1000000000000000000000000000001:workflows:nightly-export': ['status-page'],
  'a1000000000000000000000000000001:r2:newsletter-spike': ['newsletter'],
};

const FIXTURE_ALL: Record<string, string[]> = {
  ...FIXTURE_ASSIGN,
  ...FIXTURE_LOCAL,
  'a3000000000000000000000000000003:workers:quizgame': ['env=production', 'quizgame'],
  'a3000000000000000000000000000003:workers:admin': ['env=production', 'admin'],
};

/** Each account's own tags: the styles above, in every account that uses them. */
const FIXTURE_TAG_LIST: Tag[] = FIXTURE_TAG_STYLE.flatMap((t) =>
  [
    ...new Set(
      Object.entries(FIXTURE_ALL)
        .filter(([, ns]) => ns.includes(t.name))
        .map(([id]) => id.split(':')[0] ?? ''),
    ),
  ].map((acct) => ({ ...t, acct })),
);

export const FIXTURE_TAGS: TagsState = {
  tags: FIXTURE_TAG_LIST,
  assign: FIXTURE_ALL,
  local: FIXTURE_LOCAL,
  access: {
    a1000000000000000000000000000001: { write: true },
    a2000000000000000000000000000002: { write: false },
    a3000000000000000000000000000003: { write: true },
  },
  readAt: new Date().toISOString(),
};

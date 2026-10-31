/**
 * One sanity run: boot one built checkout of usageflare locally (wrangler's local runtime, sample
 * data, no network, no Cloudflare account), exercise it, and write every number it can see to a
 * JSON file. `compare.ts` diffs two such files. Nothing judges here: it only measures.
 *
 *   node --experimental-strip-types e2e/sanity/run.ts <built checkout dir> <out.json>
 *
 * Node, not Bun: wrangler's local runtime answers Node's fetch (Bun's hangs).
 *
 * Probes: every GET /api route (per account where it takes one), each 5 times; each page held open
 * 15 s after it settles at desktop and phone size; an idle soak; the bundle's size.
 */
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg || !outArg) {
  console.error('usage: node --experimental-strip-types e2e/sanity/run.ts <checkout dir> <out.json>');
  process.exit(3);
}
const DIR = resolve(dirArg);
const OUT = resolve(outArg);
const BUILD = join(DIR, 'dist', 'usageflare');
const HELD_MS = Number(process.env.SANITY_HOLD_MS ?? 15_000);
const IDLE_MS = Number(process.env.SANITY_IDLE_MS ?? 30_000);
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (why: string): never => {
  console.error(`sanity: ${why}`);
  process.exit(3);
};
if (!existsSync(join(BUILD, 'wrangler.json'))) fail(`no build in ${BUILD}: run bun run build there first`);

const require = createRequire(join(DIR, 'package.json'));
const wrangler = require('wrangler') as typeof import('wrangler');
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

// ---- config: the built wrangler.json, its entry wrapped by the counter, sample data on ----
const cfg = JSON.parse(readFileSync(join(BUILD, 'wrangler.json'), 'utf8'));
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'entry.ts'), join(BUILD, '.sanity-entry.ts'));
const keep = [
  'name',
  'compatibility_date',
  'compatibility_flags',
  'kv_namespaces',
  'durable_objects',
  'migrations',
  'vars',
];
const run = Object.fromEntries(Object.entries(cfg).filter(([k]) => keep.includes(k)));
Object.assign(run, {
  main: '.sanity-entry.ts',
  assets: { ...cfg.assets, directory: resolve(BUILD, cfg.assets.directory) },
  vars: { ...cfg.vars, FIXTURES: '1', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
});
const cfgPath = join(BUILD, '.sanity.wrangler.json');
writeFileSync(cfgPath, JSON.stringify(run, null, 2));
const PERSIST = join(DIR, '.sanity-state');
rmSync(PERSIST, { recursive: true, force: true });

// Sample data is served only on localhost (worker/fixtures.ts), and Access is off there.
const HOST = 'http://localhost';
let outbound = 0;
const worker = await wrangler.unstable_startWorker({
  config: cfgPath,
  dev: {
    remote: false,
    persist: PERSIST,
    watch: false,
    inspector: false,
    logLevel: 'error',
    server: { port: 0 },
    outboundService: async () => {
      outbound++;
      return new Response('no network in a sanity run', { status: 503 });
    },
  },
});

type Bag = Record<string, number>;
const probes: Record<string, Bag> = {};
const add = (probe: string, bag: Bag) => {
  probes[probe] = { ...(probes[probe] ?? {}), ...bag };
};
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0) : 0;
};
const sumInto = (into: Bag, from: Bag) => {
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
};

// CPU: the local runtime's own processes, read from /proc (Linux) around each call. Calls run one
// at a time, so the difference is that call's CPU (the runtime's, not Cloudflare's billed CPU).
const runtimePids = () =>
  existsSync('/proc')
    ? readdirSync('/proc').filter((d) => {
        if (!/^\d+$/.test(d)) return false;
        try {
          return readFileSync(`/proc/${d}/comm`, 'utf8').trim() === 'workerd';
        } catch {
          return false;
        }
      })
    : [];
const cpuMs = () => {
  let ns = 0;
  for (const pid of runtimePids()) {
    try {
      for (const task of readdirSync(`/proc/${pid}/task`))
        ns += Number(readFileSync(`/proc/${pid}/task/${task}/schedstat`, 'utf8').split(' ')[0]);
    } catch {}
  }
  return ns / 1e6;
};

const t0 = Date.now();
await worker.ready;
log(`booted ${DIR} locally in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// One request at a time, so each response's cost is its own even while pages run side by side.
let queue: Promise<unknown> = Promise.resolve();
const send = async (path: string, init: RequestInit = {}) => {
  const c0 = cpuMs();
  const res = await worker.fetch(`${HOST}${path}`, { ...init, redirect: 'manual' } as never);
  const body = [101, 204, 205, 304].includes(res.status) ? null : await res.arrayBuffer();
  const cost = {
    ...JSON.parse(res.headers.get('x-sanity') ?? '{}'),
    cpuMs: Math.round((cpuMs() - c0) * 10) / 10,
  };
  const headers = new Headers(res.headers as unknown as HeadersInit);
  headers.set('x-sanity', JSON.stringify(cost));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
};
const call = (path: string, init: RequestInit = {}): Promise<Response> => {
  const r = queue.then(() => send(path, init));
  queue = r.then(
    async (x) => {
      await x.clone().arrayBuffer();
    },
    () => {},
  );
  return r;
};

// The seed: the sample accounts. Both sides must see the same ones, or every other number is suspect.
const accounts = (await (await call('/api/accounts')).json()) as
  | { id: string }[]
  | { accounts: { id: string }[] };
const ids = (Array.isArray(accounts) ? accounts : (accounts.accounts ?? [])).map((a) => a.id);
if (!ids.length) fail('the sample data has no accounts (is FIXTURES=1 reaching the Worker?)');
add('seed', { accounts: ids.length });

/** The GET /api routes the Worker declares; `:id` takes each account, `:page` each view page. */
function routes(): string[] {
  const src = readFileSync(join(DIR, 'worker', 'index.ts'), 'utf8');
  const pages = [
    ...(src.match(/const viewPage = z\.object\(\{\s*page: z\.enum\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(
      /'([^']+)'/g,
    ),
  ].map((m) => m[1] as string);
  const out = new Set<string>();
  for (const m of src.matchAll(/\.get\('(\/[^']*)'/g)) {
    const r = m[1] as string;
    if (r.startsWith('/app') || r === '/limits' || r === '/resources' || r.startsWith('/a/')) continue;
    if (r.includes(':id')) for (const id of ids) out.add(`/api${r.replace(':id', id)}`);
    else if (r.includes(':page')) for (const p of pages) out.add(`/api${r.replace(':page', p)}`);
    else if (!r.includes(':')) out.add(`/api${r}`);
  }
  return [...out].sort();
}

// 1. Routes, 5 calls each (the first warms the cache, as a returning person's would be)
for (const r of routes()) {
  const ms: number[] = [];
  const bag: Bag = {};
  let bytes = 0;
  let errors = 0;
  let status = 0;
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    const res = await call(r);
    const body = await res.arrayBuffer();
    ms.push(performance.now() - s);
    bytes = body.byteLength;
    status = res.status;
    if (res.status >= 500) errors++;
    const x = res.headers.get('x-sanity');
    if (x) sumInto(bag, JSON.parse(x));
  }
  for (const k of Object.keys(bag)) bag[k] = Math.round(((bag[k] ?? 0) / 5) * 10) / 10;
  add(`GET ${r}`, {
    ...bag,
    status,
    errors5xx: errors,
    bytes,
    // The median of 5: one slow call (a cold start, a busy machine) is not a change.
    'latency.p50': Math.round(pct(ms, 0.5)),
  });
}
log(`${routes().length} routes probed`);

// 2. Pages, desktop and phone, each held open
const acct = ids[0];
const PAGES = [
  '/app/',
  '/app/limits',
  '/app/resources',
  '/app/tags',
  '/app/watchdog',
  `/app/a/${acct}`,
  `/app/a/${acct}/limits`,
];
const label = (p: string) => p.replace(acct as string, ':acct');
const browser = await chromium.launch();
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
// One size at a time, its pages side by side: fewer pages at once keeps browser timings steady.
for (const [size, viewport] of Object.entries(SIZES)) {
  await Promise.all(
    PAGES.map(async (path) => {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      const bag: Bag = {
        requests: 0,
        requestsAfterIdle: 0,
        consoleErrors: 0,
        pageErrors: 0,
        failedRequests: 0,
        transferBytes: 0,
      };
      // Idle starts once the page has settled (its first /api call, then none for 3 s), not at a fixed time: pages
      // load side by side through one queue, so a fixed time would count a slow load as polling.
      let idle = false;
      let lastApi = 0;
      page.on('console', (m) => {
        if (m.type() === 'error') bag.consoleErrors = (bag.consoleErrors ?? 0) + 1;
      });
      page.on('pageerror', () => {
        bag.pageErrors = (bag.pageErrors ?? 0) + 1;
      });
      await page.route(`${HOST}/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        bag.requests = (bag.requests ?? 0) + 1;
        // After idle, only data calls count: telemetry beacons (/api/t) are expected.
        if (url.pathname.startsWith('/api/') && url.pathname !== '/api/t') lastApi = Date.now();
        if (idle && url.pathname.startsWith('/api/') && url.pathname !== '/api/t') {
          bag.requestsAfterIdle = (bag.requestsAfterIdle ?? 0) + 1;
          // Which call it was, so a flag names it.
          const k = `afterIdle.${url.pathname.replace(/[a-f0-9]{32}/g, ':id')}`;
          bag[k] = (bag[k] ?? 0) + 1;
        }
        const res = await call(url.pathname + url.search, {
          method: req.method(),
          headers: req.headers(),
          body: (req.postDataBuffer() ?? undefined) as BodyInit | undefined,
        });
        const body = Buffer.from(await res.arrayBuffer());
        bag.transferBytes = (bag.transferBytes ?? 0) + body.byteLength;
        if (res.status >= 400) bag.failedRequests = (bag.failedRequests ?? 0) + 1;
        const x = res.headers.get('x-sanity');
        if (x) sumInto(bag, JSON.parse(x));
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        await route.fulfill({ status: res.status, headers, body });
      });
      await page.route(/^(?!http:\/\/localhost\/)/, (route) => route.abort());
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.goto(`${HOST}${path}`, { waitUntil: 'load' }).catch(() => {
        bag.pageErrors = (bag.pageErrors ?? 0) + 1;
      });
      const settle = Date.now();
      while ((!lastApi || Date.now() - lastApi < 3_000) && Date.now() - settle < HELD_MS)
        await page.waitForTimeout(250);
      idle = true;
      // Then held as long again as the hold: a page that polls every few seconds shows here.
      await page.waitForTimeout(HELD_MS);
      const { metrics } = (await cdp.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      for (const m of metrics) {
        if (
          [
            'JSHeapUsedSize',
            'LayoutCount',
            'RecalcStyleCount',
            'ScriptDuration',
            'TaskDuration',
            'Nodes',
            'JSEventListeners',
          ].includes(m.name)
        )
          bag[`browser.${m.name}`] = Math.round(m.name.endsWith('Duration') ? m.value * 1000 : m.value);
      }
      add(`page ${label(path)} (${size})`, bag);
      await ctx.close();
    }),
  );
}
await browser.close();
log(`${PAGES.length} pages held ${HELD_MS / 1000} s at desktop and phone`);

// 3. Idle soak: nobody uses the app; anything that still runs on its own shows here.
{
  const before = (await (await worker.fetch(`${HOST}/__sanity/counters`)).json()) as Bag;
  const out0 = outbound;
  const c0 = cpuMs();
  await new Promise((r) => setTimeout(r, IDLE_MS));
  const cpu = cpuMs() - c0;
  const after = (await (await worker.fetch(`${HOST}/__sanity/counters`)).json()) as Bag;
  const bag: Bag = { outboundCalls: outbound - out0, cpuMs: Math.round(cpu * 10) / 10 };
  for (const k of Object.keys(after)) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d) bag[k] = d;
  }
  add(`idle ${IDLE_MS / 1000} s`, bag);
}

// 4. Bundle bytes
{
  const dir = join(DIR, 'dist', 'client', 'assets');
  let js = 0;
  let css = 0;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (f.endsWith('.js')) js += statSync(join(dir, f)).size;
    if (f.endsWith('.css')) css += statSync(join(dir, f)).size;
  }
  add('bundle', { jsBytes: js, cssBytes: css, workerBytes: statSync(join(BUILD, 'index.js')).size });
}

await worker.dispose();
rmSync(PERSIST, { recursive: true, force: true });
let sha = '';
try {
  sha = (await import('node:child_process'))
    .execSync('git rev-parse --short HEAD', { cwd: DIR })
    .toString()
    .trim();
} catch {}
const seconds = Math.round((Date.now() - t0) / 1000);
writeFileSync(OUT, JSON.stringify({ dir: DIR, sha, at: new Date().toISOString(), seconds, probes }, null, 2));
log(`done in ${seconds} s → ${OUT}`);
process.exit(0);

/**
 * Returning-user check (prod safety rule 4): the production build in a real browser, opened the way
 * people really come back to it. Each case must draw a page with data, with no console error:
 *
 *   fresh         a first visit, nothing saved
 *   saved         a reload with saved data while the server is slow: it must draw from the device
 *   stuck store   IndexedDB never answers: the app gives up on it and asks the server
 *   slow store    IndexedDB answers after 5 s: same
 *   broken store  the saved copy is garbage: it is dropped, the server answers
 *   no storage    storage throws (a locked-down browser): the server answers
 *
 *   bun run build && bunx vite preview --port 4173      # with `.dev.vars` FIXTURES=1 (bun e2e/local.ts does it all)
 *   bun e2e/returning.ts                                 # default --base http://localhost:4173
 *   bun e2e/returning.ts --base https://usageflare.icaruslab.dev   # live (tester token, GETs only)
 *
 * Exits 1 on any failure.
 */
import { type BrowserContext, chromium, type Page } from 'playwright';

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = (arg('base', 'http://localhost:4173') as string).replace(/\/$/, '');
const LIVE = !/localhost|127\.0\.0\.1/.test(BASE);
const PAGES = ['/app/', '/app/limits', '/app/resources'];
/** A first visit or a store that gave up: the server's answer, cold. */
const SERVER_MS = LIVE ? 20_000 : 10_000;
/** A reload with saved data draws from the device, well before the (held back) server answers. */
const SAVED_MS = 3_000;
/** How long the slow and stuck cases hold IndexedDB and the server. */
const HOLD_MS = 5_000;

const failures: string[] = [];
const fail = (where: string, what: string) => {
  failures.push(`${where}: ${what}`);
  console.log(`  ✗ ${where}: ${what}`);
};

/** IndexedDB that never answers (`ms` undefined) or answers after `ms`. */
const holdIndexedDB = (ms?: number) => `(() => {
  const real = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...a) => {
    const fake = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null,
      addEventListener() {}, removeEventListener() {} };
    ${
      ms === undefined
        ? ''
        : `setTimeout(() => {
      const req = real(...a);
      req.onupgradeneeded = (e) => { fake.result = req.result; fake.onupgradeneeded?.(e); };
      req.onsuccess = (e) => { fake.result = req.result; fake.onsuccess?.(e); };
      req.onerror = (e) => { fake.error = req.error; fake.onerror?.(e); };
      req.onblocked = (e) => fake.onblocked?.(e);
    }, ${ms});`
    }
    return fake;
  };
})();`;

const BREAK_STORE = `(() => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('usageflare')) localStorage.setItem(k, '{not json'); } catch {}
  const real = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...a) => {
    const req = real(...a);
    req.addEventListener('success', () => {
      try {
        const db = req.result;
        for (const s of db.objectStoreNames) db.transaction(s, 'readwrite').objectStore(s).put('{not json', 'queries');
      } catch {}
    });
    return req;
  };
})();`;

const NO_STORAGE = `(() => {
  const boom = () => { throw new DOMException('denied', 'SecurityError'); };
  Object.defineProperty(window, 'localStorage', { get: boom });
  Object.defineProperty(window, 'indexedDB', { get: boom });
})();`;

type State = Awaited<ReturnType<BrowserContext['storageState']>>;

async function newContext(browser: Awaited<ReturnType<typeof chromium.launch>>, storageState?: State) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
  if (LIVE) {
    const id = process.env.USAGEFLARE_ACCESS_CLIENT_ID;
    const secret = process.env.USAGEFLARE_ACCESS_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Live runs need USAGEFLARE_ACCESS_CLIENT_ID and _SECRET');
    const host = new URL(BASE).host;
    // The token goes to the app's own host only, and nothing is written.
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (new URL(req.url()).host !== host) return route.continue();
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return route.abort();
      return route.continue({
        headers: { ...req.headers(), 'cf-access-client-id': id, 'cf-access-client-secret': secret },
      });
    });
  }
  return ctx;
}

/** Holds every /api answer back by `ms`, as a slow server would. */
const slowServer = (ctx: BrowserContext, ms: number) =>
  ctx.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.fallback().catch(() => {});
  });

function watch(p: Page, where: string) {
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    // Live, the tester token opens this app only: another suite app's Access login (the app
    // switcher's hub) answers it with a CORS error a signed-in person never sees.
    if (
      m.type() === 'error' &&
      !/Failed to load resource.*(net::ERR_FAILED|ERR_ABORTED)/.test(m.text()) &&
      !(LIVE && /cloudflareaccess\.com\/cdn-cgi\/access\/login/.test(m.text()))
    )
      errors.push(m.text());
  });
  return () => {
    for (const e of errors.splice(0)) fail(where, `console: ${e.slice(0, 160)}`);
  };
}

/** Time until the page shows data: its first table row or metric card, and no skeleton left. */
async function drawn(p: Page, url: string, within: number, where: string) {
  const t0 = Date.now();
  await p.goto(BASE + url, { waitUntil: 'commit' });
  const ok = await p
    .waitForFunction(
      () =>
        !!document.querySelector('main tbody tr, main [data-slot=tile]') &&
        !document.querySelector('main [data-slot=skeleton]'),
      null,
      { timeout: within, polling: 50 },
    )
    .then(() => true)
    .catch(() => false);
  const ms = Date.now() - t0;
  if (!ok) fail(where, `no data on ${url} within ${within} ms`);
  else console.log(`  ✓ ${where} ${url} in ${ms} ms`);
  return ok;
}

async function main() {
  const browser = await chromium.launch();
  console.log(`Returning-user check against ${BASE}`);

  // Fresh, then a reload with saved data while the server is slow.
  {
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    const flush = watch(p, 'fresh');
    for (const url of PAGES) await drawn(p, url, SERVER_MS, 'fresh');
    flush();
    // Saved answers are written about a second after they change.
    await p.waitForTimeout(2500);
    await slowServer(ctx, HOLD_MS * 2);
    const flushSaved = watch(p, 'saved');
    for (const url of PAGES) await drawn(p, url, SAVED_MS, 'saved');
    await ctx.unrouteAll({ behavior: 'ignoreErrors' });
    flushSaved();
    // What this browser saved, local storage and IndexedDB both, for the next cases to start from.
    const saved = await ctx.storageState({ indexedDB: true });

    // The same saved data, then the store stops answering, or answers late.
    for (const [where, script] of [
      ['stuck store', holdIndexedDB()],
      ['slow store', holdIndexedDB(HOLD_MS)],
    ] as const) {
      const c = await newContext(browser, saved);
      await c.addInitScript(script);
      const q = await c.newPage();
      const f = watch(q, where);
      await drawn(q, PAGES[0], SERVER_MS, where);
      f();
      await c.close();
    }
    await ctx.close();
  }

  // A store holding garbage, and storage that throws.
  for (const [where, script] of [
    ['broken store', BREAK_STORE],
    ['no storage', NO_STORAGE],
  ] as const) {
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    // A first visit fills the store; the second opens it broken.
    await drawn(p, PAGES[0], SERVER_MS, `${where} (prime)`);
    await p.waitForTimeout(2500);
    await ctx.addInitScript(script);
    const flush = watch(p, where);
    await drawn(p, PAGES[0], SERVER_MS, where);
    flush();
    await ctx.close();
  }

  await browser.close();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nAll returning-user cases drew data.');
}

await main();

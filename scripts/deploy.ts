/**
 * Deploy, then verify live, and roll back on its own if the live app is broken (prod safety rule 5).
 * Workers Builds runs it as the deploy command after `bun run build`:
 *
 *   1. note the version serving now (what a rollback returns to)
 *   2. `wrangler deploy`
 *   3. wait until the live `/api/health` sha is this build's commit (`buildSha()`)
 *   4. signed in (the read-only tester service token, `USAGEFLARE_ACCESS_CLIENT_ID` / `_SECRET`):
 *      the landing page, the app shell and every script and stylesheet it names, and `/api`:
 *      me, accounts, every account's usage, prefs, tags, a saved view, releases
 *   5. any failure: `wrangler rollback` to the version from step 1, and the build fails
 *
 *   bun scripts/deploy.ts --verify-only       # steps 3 and 4 against the live app, no deploy (step 3
 *                                             # only when WORKERS_CI_COMMIT_SHA is set)
 */
import { $ } from 'bun';
import { buildSha } from './build-sha';

const BASE = (process.env.USAGEFLARE_URL ?? 'https://usageflare.icaruslab.dev').replace(/\/$/, '');
const NAME = 'usageflare';
const VERIFY_ONLY = process.argv.includes('--verify-only');
/** In `--verify-only` only a sha given in the environment is waited for. */
const SHA = VERIFY_ONLY ? (process.env.WORKERS_CI_COMMIT_SHA ?? '') : buildSha();
const ID = process.env.USAGEFLARE_ACCESS_CLIENT_ID ?? '';
const SECRET = process.env.USAGEFLARE_ACCESS_CLIENT_SECRET ?? '';
/** How long the new version may take to reach the edge. */
const PROPAGATE_MS = 180_000;
/** One check's bound: a cold usage read can take a while. */
const CALL_MS = 30_000;

const headers = ID && SECRET ? { 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET } : undefined;

async function get(path: string, accept = 'application/json') {
  const res = await fetch(BASE + path, {
    headers: { accept, ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(CALL_MS),
  });
  return { res, text: await res.text() };
}

async function json<T>(path: string): Promise<T> {
  const { res, text } = await get(path);
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not JSON: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the live Worker to report this build's sha. */
async function waitForSha() {
  if (!/^[0-9a-f]{7,40}$/.test(SHA))
    throw new Error(`build sha "${SHA}" is not a commit: no way to tell this build went live`);
  const until = Date.now() + PROPAGATE_MS;
  let last = '';
  while (Date.now() < until) {
    last = await json<{ sha?: string }>('/api/health').then(
      (h) => h.sha ?? '(none)',
      (e) => String(e),
    );
    if (last === SHA) return;
    await sleep(5_000);
  }
  throw new Error(`live sha is ${last}, not ${SHA}, after ${PROPAGATE_MS / 1000} s`);
}

/** The pages and `/api` a signed-in person loads, on every account. */
async function checkLive() {
  const landing = await get('/', 'text/html');
  if (landing.res.status !== 200) throw new Error(`/ answered ${landing.res.status}`);
  const shell = await get('/app/', 'text/html');
  if (shell.res.status !== 200 || !shell.text.includes('<div id="root"'))
    throw new Error(`/app/ answered ${shell.res.status} without the app shell`);
  const assets = [...shell.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(
    (m) => m[1] ?? '',
  );
  if (!assets.length) throw new Error('/app/ names no scripts');
  for (const a of assets) {
    const r = await get(a, '*/*');
    if (r.res.status !== 200) throw new Error(`${a} answered ${r.res.status}`);
  }
  const me = await json<{ email?: string }>('/api/me');
  if (typeof me.email !== 'string') throw new Error('/api/me has no email field');
  const { accounts, errors } = await json<{ accounts: { id: string; name: string }[]; errors: unknown[] }>(
    '/api/accounts',
  );
  if (!accounts?.length) throw new Error(`/api/accounts lists no accounts (${JSON.stringify(errors)})`);
  for (const a of accounts) {
    const u = await json<{ account?: { id?: string }; resources?: unknown[] }>(`/api/accounts/${a.id}/usage`);
    if (u.account?.id !== a.id || !Array.isArray(u.resources))
      throw new Error(`/api/accounts/${a.id}/usage (${a.name}) is not a usage reply`);
    console.log(`  ✓ ${a.name}: ${u.resources.length} resources`);
  }
  await json('/api/prefs');
  await json('/api/tags');
  await json('/api/views/overview');
  await json('/api/releases');
  console.log(`  ✓ landing, app shell, ${assets.length} assets, /api on ${accounts.length} accounts`);
}

async function verify() {
  if (!headers)
    throw new Error('USAGEFLARE_ACCESS_CLIENT_ID / _SECRET are not set: the live app cannot be checked');
  console.log(`Verifying ${BASE} is ${SHA || '(no sha)'}`);
  // A manual `--verify-only` with no sha checks the live app as it stands.
  if (SHA || !VERIFY_ONLY) await waitForSha();
  await checkLive();
}

if (VERIFY_ONLY) {
  await verify();
  process.exit(0);
}

// What serves now, for the rollback.
const status = await $`bunx wrangler deployments status --name ${NAME} --json`.quiet().nothrow();
const before = (() => {
  try {
    const d = JSON.parse(status.stdout.toString()) as {
      versions?: { version_id: string; percentage: number }[];
    };
    return [...(d.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
  } catch {
    return undefined;
  }
})();
console.log(`Serving before deploy: ${before ?? '(unknown)'}`);

await $`bunx wrangler deploy`;

try {
  await verify();
  console.log('Live and verified.');
} catch (e) {
  const why = e instanceof Error ? e.message : String(e);
  console.error(`✗ Live check failed: ${why}`);
  if (before) {
    console.error(`Rolling back to ${before}`);
    await $`bunx wrangler rollback ${before} --name ${NAME} -y --message ${`auto-rollback: ${why}`.slice(0, 100)}`;
  } else {
    console.error('No earlier version known: rolling back to the previous deployment');
    await $`bunx wrangler rollback --name ${NAME} -y --message ${'auto-rollback: live check failed'}`;
  }
  process.exit(1);
}

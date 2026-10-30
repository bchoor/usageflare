/**
 * The local sanity run: what CI no longer runs (CI is lint, typecheck and build only, under a
 * minute). Run it before calling a change done, on sample data (`FIXTURES=1`):
 *
 *   bun e2e/local.ts                      # returning-user check, then the full UI smoke
 *   bun e2e/local.ts --quick              # returning-user check only (~20 s)
 *   bun e2e/local.ts --only limits --vp phone   # other flags go to e2e/smoke.ts
 *
 * Starts the production build (vite preview :4173) for e2e/returning.ts and the dev server (:5173)
 * for e2e/smoke.ts, and stops both. Writes `.dev.vars` with sample data if there is none. Exits 1
 * on any failure.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Subprocess, spawn } from 'bun';

const QUICK = process.argv.includes('--quick');
const smokeArgs = process.argv.slice(2).filter((a) => a !== '--quick');

if (!existsSync('.dev.vars')) {
  writeFileSync(
    '.dev.vars',
    `FIXTURES=1\nACCESS_TEAM_DOMAIN=\nACCESS_AUD=\nSETTINGS_KEY=${randomBytes(32).toString('base64')}\n`,
  );
} else if (!/^FIXTURES=1$/m.test(readFileSync('.dev.vars', 'utf8'))) {
  console.error('.dev.vars has no FIXTURES=1: the checks need sample data. Add it and run again.');
  process.exit(1);
}

const run = async (cmd: string[]) =>
  (await spawn(cmd, { stdout: 'inherit', stderr: 'inherit' }).exited) === 0;

/** Starts a server and waits (at most 90 s) for its /api to answer. */
const serve = async (cmd: string[], port: number): Promise<Subprocess> => {
  const p = spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const up = await fetch(`http://localhost:${port}/api/accounts`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return p;
    await Bun.sleep(1_000);
  }
  p.kill();
  throw new Error(`server on :${port} did not answer in 90 s`);
};

let ok = true;

console.log('\n== Returning user (production build) ==');
ok = (await run(['bun', 'run', 'build'])) && ok;
const preview = await serve(['bunx', 'vite', 'preview', '--port', '4173', '--strictPort'], 4173);
try {
  ok = (await run(['bun', 'e2e/returning.ts'])) && ok;
} finally {
  preview.kill();
}

if (!QUICK) {
  console.log('\n== UI smoke (dev server) ==');
  const dev = await serve(['bunx', 'vite', '--port', '5173', '--strictPort'], 5173);
  try {
    ok = (await run(['bun', 'e2e/smoke.ts', ...smokeArgs])) && ok;
  } finally {
    dev.kill();
  }
}

console.log(ok ? '\nLocal sanity: all passed' : '\nLocal sanity: FAILED');
process.exit(ok ? 0 : 1);

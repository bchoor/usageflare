/**
 * `bun run sanity`: is this checkout abnormal next to main? Local only, never in CI.
 *
 * Builds main (the merge base with origin/main) in .sanity/base and this checkout, runs the same
 * probes on both (run.ts: wrangler's local runtime, sample data, no network, no Cloudflare quota)
 * and diffs every number (compare.ts). It judges by difference, not by expected values: anything
 * that moved 3× or more, anything new, and a few absolute floors (errors, calls after idle, calls
 * out, KV writes while idle). Prints one PASS line or FAIL in at most 10 lines; paste it into the
 * PR body. Exit 0 PASS, 2 flagged, 3 error (build, boot, sample data).
 *
 * Node, not Bun, for the runs: wrangler's local runtime answers Node's fetch (Bun's hangs).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = execSync('git rev-parse --show-toplevel').toString().trim();
const out = join(root, '.sanity');
const base = join(out, 'base');
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const node = 'node --experimental-strip-types --no-warnings';

mkdirSync(out, { recursive: true });
sh('git fetch -q origin main');
const sha = execSync('git merge-base HEAD origin/main').toString().trim();
let code = 0;
try {
  if (!existsSync(base)) sh(`git worktree add -f -q ${base} ${sha}`);
  else sh(`git checkout -q --detach ${sha}`, base);
  console.log(`sanity: main at ${sha.slice(0, 7)} vs this checkout`);
  // Both sides are always built: a dist/ left from an earlier build gives stale numbers.
  sh('bun install --frozen-lockfile --silent', base);
  sh('bun run build >/dev/null', base);
  sh('bun run build >/dev/null');
  const run = (dir: string, file: string) =>
    sh(`${node} ${join(root, 'e2e/sanity/run.ts')} ${dir} ${join(out, file)}`);
  run(base, 'main.json');
  run(root, 'pr.json');
  sh(`${node} ${join(root, 'e2e/sanity/compare.ts')} ${join(out, 'main.json')} ${join(out, 'pr.json')}`);
} catch (e) {
  // compare.ts exits 2 on a flag; anything else (a build, a boot, the sample data) is an error: 3.
  code = (e as { status?: number }).status === 2 ? 2 : 3;
} finally {
  // main's checkout is only needed for the run: remove it (its numbers stay in .sanity/main.json).
  try {
    sh(`git worktree remove --force ${base}`);
  } catch {}
}
process.exit(code);

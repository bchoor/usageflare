import { execSync } from 'node:child_process';

/**
 * The commit this build is made from. Workers Builds sets `WORKERS_CI_COMMIT_SHA`, but a build
 * started by branch (a manual rebuild) sets it to the branch name, so a value that is not a commit
 * falls back to the checkout's HEAD. `dev` when neither is known.
 */
export function buildSha(): string {
  const env = process.env.WORKERS_CI_COMMIT_SHA ?? '';
  if (/^[0-9a-f]{7,40}$/.test(env)) return env;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return env || 'dev';
  }
}

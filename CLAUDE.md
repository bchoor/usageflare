# usageflare

- Bun only (`bun`, `bunx`). Checks: `bun run lint && bun run type-check && bun run build`.
- No unit tests (Bikram, 2026-10-24): CI is lint, typecheck, build; e2e only when appropriate. The thread that builds a change owns its review.
- UI gate: `bun e2e/smoke.ts` (dev server with `FIXTURES=1` on :5173) drives every page, Settings section and control at phone and desktop, light and dark, and fails on broken interactions, cut-off, overlapping or wrapping content, scroll boxes that won't scroll, popups with no way out, low contrast, small tap targets, missing focus rings, console errors and failed calls. Run it before saying any UI change is done, and `--base https://usageflare.icaruslab.dev` (read-only, tester token) after it's live. CI runs it on every PR and lists screenshots that differ from main.
- UI comes from `@columenlabs/lumen-ui` and `-ui-types` (LumenShell, Settings sections, `ui/*` shadcn parts); don't hand-roll components the kit has.
- Secrets the person enters go in KV through `worker/secrets.ts` (AES-GCM under `SETTINGS_KEY`), never back out through the API.
- Every `/api` route sits behind `requireAccess` (Cloudflare Access JWT) and `sameOrigin` for writes.
- Deploys: Workers Builds on push to main, deploy command `bun scripts/deploy.ts` (verifies live, rolls back on failure). Releases: lumen-ship every 10 merges.

## Prod safety (Bikram, 2026-10-27): no stalls, no broken deploys
1. Never block the hot path. No heavy or unbounded work on app load, on a request, or when a Durable Object wakes. Backfills, migrations and recounts run as small, budgeted background steps (alarms or queues) that resume from a bookmark and never hold a request; a fix-up of old data on read is written in `waitUntil`.
2. Every wait has a timeout and a fallback. Device caches go through lumen `savedAnswers` (gives up in 1.5 s); browser calls through `apiJson` / `fetchWithin`; every Worker call to Cloudflare carries `AbortSignal.timeout`, and a failed read serves the last KV copy (marked stale) instead of an error. Never wait forever.
3. Schema changes are backward compatible: add fields, keys or tables, never rename or drop what an older build reads; a changed KV shape gets a new key version (`usage:v2`); readers default missing fields; every `INSERT` names its columns. A rollback must keep working on new data.
4. Test like a returning user: `bun e2e/returning.ts` against the production build (`bun run build && bunx vite preview --port 4173`, FIXTURES=1): fresh load, reload with saved data on a slow server, stuck/slow/broken/missing store. CI runs it on every PR.
5. Verify live, not just the build: after each deploy, the live build sha = main HEAD and the key pages plus `/api` render signed in on every account; on failure it rolls back on its own, then you fix. `scripts/deploy.ts` does it as the Workers Builds deploy command (`/api/health` answers the build's `sha`); `bun scripts/deploy.ts --verify-only` checks live by hand, and `bun e2e/returning.ts --base https://usageflare.icaruslab.dev` runs the returning-user cases live.
6. One change at a time: merges at least a minute apart, wait for each deploy to verify before the next, correctness fixes ship alone.
7. If prod breaks: roll back first, then find the cause in the logs, then fix it generally so it can't recur.


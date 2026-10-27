# usageflare

- Bun only (`bun`, `bunx`). Checks: `bun run lint && bun run type-check && bun run build`.
- No unit tests (Bikram, 2026-10-24): CI is lint, typecheck, build; e2e only when appropriate. The thread that builds a change owns its review.
- UI gate: `bun e2e/smoke.ts` (dev server with `FIXTURES=1` on :5173) drives every page, Settings section and control at phone and desktop, light and dark, and fails on broken interactions, cut-off, overlapping or wrapping content, scroll boxes that won't scroll, popups with no way out, low contrast, small tap targets, missing focus rings, console errors and failed calls. Run it before saying any UI change is done, and `--base https://usageflare.icaruslab.dev` (read-only, tester token) after it's live. CI runs it on every PR and lists screenshots that differ from main.
- UI comes from `@columenlabs/lumen-ui` and `-ui-types` (LumenShell, Settings sections, `ui/*` shadcn parts); don't hand-roll components the kit has.
- Secrets the person enters go in KV through `worker/secrets.ts` (AES-GCM under `SETTINGS_KEY`), never back out through the API.
- Every `/api` route sits behind `requireAccess` (Cloudflare Access JWT) and `sameOrigin` for writes.
- Deploys: Workers Builds on push to main. Releases: lumen-ship every 10 merges.

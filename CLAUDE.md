# flareusage

- Bun only (`bun`, `bunx`). Checks: `bun run lint && bun run type-check && bun run build`.
- No unit tests (Bikram, 2026-10-24): CI is lint, typecheck, build; e2e only when appropriate. The thread that builds a change owns its review.
- UI comes from `@columenlabs/lumen-ui` and `-ui-types` (LumenShell, Settings sections, `ui/*` shadcn parts); don't hand-roll components the kit has.
- Secrets the person enters go in KV through `worker/secrets.ts` (AES-GCM under `SETTINGS_KEY`), never back out through the API.
- Every `/api` route sits behind `requireAccess` (Cloudflare Access JWT) and `sameOrigin` for writes.
- Deploys: Workers Builds on push to main. Releases: lumen-ship every 10 merges.

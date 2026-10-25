# flareusage

Cloudflare usage dashboard across one or more accounts, pairing usage and limits with the real services and resources behind them. UI built with [`@columenlabs/lumen-ui`](https://www.npmjs.com/package/@columenlabs/lumen-ui).

## Stack

One Cloudflare Worker (`wrangler.jsonc`), built with Vite and the Cloudflare Vite plugin. Hono serves `/api/*` (`worker/`) and the same Worker serves the React SPA (`src/`) as static assets.

| Binding | What |
|---|---|
| `KV` | The app's one KV namespace: settings and encrypted secrets |
| `SETTINGS_KEY` (secret) | 32 random bytes, base64: the AES-GCM key for secrets in KV |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (vars) | Cloudflare Access team domain and audience tag; the Worker verifies the Access JWT on every `/api` call and answers 503 when they are empty (except on localhost) |

KV layout: `secret:<name>` → `{v, kind, label, iv, ct, last4, updatedAt, updatedBy, test}`. Secrets entered in Settings ▸ Cloudflare API tokens are encrypted with AES-GCM (the name is the additional data) before they reach KV; the API is write-only and returns only the last four characters.

## Develop

```bash
bun install
printf 'SETTINGS_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars
bun run dev
bun run lint && bun run type-check && bun run build
```

## Deploy

Served at https://usageflare.icaruslab.dev (Worker custom domain, behind Cloudflare Access). Cloudflare Workers Builds deploys every push to `main` (build `bun run build`, deploy `bunx wrangler deploy`). CI (`.github/workflows/ci.yml`) runs lint, typecheck and build; there are no unit tests. Releases: `lumen-ship release` every 10 merges (`.github/workflows/release.yml`, secret `ANTHROPIC_API_KEY`, repo variable `RELEASE_ON_MERGE=true`).

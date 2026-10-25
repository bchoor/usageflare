# usageflare

Cloudflare usage dashboard across one or more accounts, pairing usage and limits with the real services and resources behind them. UI built with [`@columenlabs/lumen-ui`](https://www.npmjs.com/package/@columenlabs/lumen-ui).

## Stack

One Cloudflare Worker (`wrangler.jsonc`), built with Vite and the Cloudflare Vite plugin. Hono serves `/api/*` (`worker/`) and the same Worker serves two pages as static assets: the public landing page at `/` (`index.html`, media in `public/landing/`) and the React SPA under `/app` (`app/index.html`, `src/`). The Worker answers every `/app/*` path with the app shell and sends the old app paths (`/limits`, `/resources`, `/a/*`) to `/app`.

| Binding | What |
|---|---|
| `KV` | The app's one KV namespace: settings and encrypted secrets |
| `ASSETS` | Static assets: the landing page and the app shell |
| `SETTINGS_KEY` (secret) | 32 random bytes, base64: the AES-GCM key for secrets in KV |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (vars) | Cloudflare Access team domain and audience tag; the Worker verifies the Access JWT on every `/api` call and answers 503 when they are empty (except on localhost) |

KV layout: `secret:<name>` → `{v, kind, label, iv, ct, last4, updatedAt, updatedBy, test}`; `accounts:v1` (10 min) → the accounts each token reaches; `usage:v2:<account>` (10 min) → that account's resources and 30 days of daily usage; `prefs:v1` → Watch threshold and plan per account; `labels:v1` → labels and which resources carry them; `view:v1:<page>` → a page's saved layout (LumenLayout view config). Secrets entered in Settings ▸ Cloudflare API tokens are encrypted with AES-GCM (the name is the additional data) before they reach KV; the API is write-only and returns only the last four characters.

## Data

`shared/catalog.ts` is the one metric model: products grouped in categories (Compute, Storage & databases, AI, Messaging), each metric with its family (requests, reads, writes, stored...), unit, kind (daily count or size) and Free/Paid allowance and price. `worker/cloudflare.ts` reads an account with the token: REST lists for resources and Worker bindings, GraphQL Analytics for usage. The UI (`src/model.ts`) judges usage against the plan: month to date on Paid, today on Free, with a forecast to month end. Anything a token can't read is named in the page, never shown as zero.

## Develop

```bash
bun install
printf 'SETTINGS_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars
bun run dev
bun run lint && bun run type-check && bun run build
```

## Deploy

Served at https://usageflare.icaruslab.dev (Worker custom domain). The landing page at `/` is public; the Cloudflare Access application covers the paths `/app` and `/api` (both hosts), and the Worker still checks the Access JWT on every `/api` call. Cloudflare Workers Builds deploys every push to `main` (build `bun run build`, deploy `bunx wrangler deploy`). CI (`.github/workflows/ci.yml`) runs lint, typecheck and build; there are no unit tests. Releases: `lumen-ship release` every 10 merges (`.github/workflows/release.yml`, secret `ANTHROPIC_API_KEY`, repo variable `RELEASE_ON_MERGE=true`).

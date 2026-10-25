# usageflare

**Every account. Every limit. One gauge.** Usage and limits for every Cloudflare account, in one place: see what's blocked, what's already billing, and what's about to run out, before it happens. UI built with [`@columenlabs/lumen-ui`](https://www.npmjs.com/package/@columenlabs/lumen-ui). MIT licensed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bchoor/usageflare)

![usageflare overview across three Cloudflare accounts](public/landing/overview.jpg)

## What it does

- **Limits.** Every allowance across accounts (Workers, KV, D1, R2, Durable Objects, Queues, Workers AI, Containers and more), measured against your Free or Paid plan and forecast to the end of the month. Each one gets a status: Blocked, Over (billed), Will exceed, Watch or OK.
- **Projects.** Cloudflare bills by resource; labels turn resources into projects across accounts. Filter for anything without a label, tag many resources in one go, group by account and product, and save the view.
- **Your own views.** Formula columns checked as you type, plus cards, charts and widgets you can drag around and save.

| Limits | Grouping |
|---|---|
| ![Limits: every allowance with forecast and status](public/landing/limits.jpg) | ![Resources grouped by account and product](public/landing/group.jpg) |
| **Formula columns** | **Widgets** |
| ![Adding a formula column](public/landing/formula.jpg) | ![Adding a widget to the dashboard](public/landing/widgets.jpg) |

The landing page at `/` plays the full narrated demo (`public/landing/demo.mp4`).

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
# Optional: sample data for three accounts, no token needed (localhost only)
printf 'FIXTURES=1\nACCESS_TEAM_DOMAIN=\nACCESS_AUD=\n' >> .dev.vars
bun run dev   # landing page at /, app at /app
bun run lint && bun run type-check && bun run build
```

## Deploy your own

It runs as one Worker and one KV namespace in your own Cloudflare account and only reads the accounts it watches.

1. Click **Deploy to Cloudflare** above. It copies this repo to your GitHub, provisions the KV namespace and deploys with Workers Builds. When asked for `SETTINGS_KEY`, paste the output of `openssl rand -base64 32`.
2. In Cloudflare Zero Trust, add a self-hosted **Access application** for your Worker's host with two paths, `/app` and `/api`, and a policy for the people who may use it. The landing page at `/` stays public.
3. Set the Worker variables `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`) and `ACCESS_AUD` (the application's audience tag). Until both are set the API answers 503.
4. Open `/app`, go to Settings, Cloudflare API tokens, and add a read-only token for each account. The **Create token** link there pre-fills the permissions it needs.

To deploy by hand instead: `bun install`, `bunx wrangler secret put SETTINGS_KEY`, set the two Access variables in `wrangler.jsonc`, then `bun run deploy`.

## Deploy (this repo's instance)

Served at https://usageflare.icaruslab.dev (Worker custom domain). The landing page at `/` is public; the Cloudflare Access application covers the paths `/app` and `/api` on the custom domain, and the Worker still checks the Access JWT on every `/api` call. Its values live in `env.production` in `wrangler.jsonc`; Cloudflare Workers Builds deploys every push to `main` with the build variable `USAGEFLARE_ENV=production` (build `bun run build`, deploy `bunx wrangler deploy`). CI (`.github/workflows/ci.yml`) runs lint, typecheck and build; there are no unit tests. Releases: `lumen-ship release` every 10 merges (`.github/workflows/release.yml`, secret `ANTHROPIC_API_KEY`, repo variable `RELEASE_ON_MERGE=true`).

## License

MIT, see [LICENSE](LICENSE).

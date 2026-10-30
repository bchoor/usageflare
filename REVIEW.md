# REVIEW.md — usageflare

What blocks a merge here. Each item points to where its rule is written.

- Every rule in [`CLAUDE.md`](CLAUDE.md), and lumen's [`REVIEW.md`](https://github.com/columenlabs/lumen/blob/main/REVIEW.md) for UI.
- A break of Prod safety (CLAUDE.md): heavy or unbounded work on load, a request or a Durable Object wake; a wait with no timeout or no fallback (a bare `fetch`, a device cache outside `savedAnswers`, a Worker call to Cloudflare with no `AbortSignal.timeout`, a failed read that errors when a last copy exists); a renamed or dropped field or KV key an older build reads, or an `INSERT` with no column names; a failing local returning-user run (`bun e2e/local.ts --quick`); a correctness fix bundled with a feature.
- A UI change with no local smoke run (`bun e2e/local.ts`) at phone and desktop, or one that fails.

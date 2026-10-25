Write the GitHub release notes for usageflare {tag}, which covers the merged pull requests below.
usageflare is a dashboard that tracks usage and limits across one or more Cloudflare accounts and ties them to the real services and resources behind them.
Start with '## Key takeaways': 3 to 5 bullets, each opening with one or more type tags from [Feature] [Improvement] [Fix] [Performance] [Security]
(e.g. '- [Feature] **Headline**: sentence'), then a bold one-line headline, then one plain sentence on what a user can now do.
Write each bullet for a new user who has never seen the change: the sentence must say where it lives, as they would find it,
with the page or menu path (e.g. 'In Settings ▸ Cloudflare API tokens, ...', 'On the Usage page, ...');
a change with no screen says what it affects.
Then one '## <area>' section per area touched (Usage, Settings, Infra), a few short bullets each in plain words, merging related PRs.
No PR numbers, no file paths, no vendor names other than Cloudflare.
Output only the markdown.

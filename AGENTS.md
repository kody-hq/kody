# kody agent index

Kody is Your agents' cloud for individuals and teams (orgs, teams, grants): each
account holds isolated packages, jobs, credentials, memories, remote connectors,
email inboxes, and durable storage.

`npm run validate` is the single authoritative local gate. UI/API: verify
locally with [control-kody](./docs/contributing/control-kody.md) first (preview
when [local cannot](./docs/contributing/cloud-agents.md#local-limitations)).

Open the page that owns the task:

- Contributor documentation map:
  [docs/contributing/index.md](./docs/contributing/index.md)
- Engineering principles: [docs/principles/](./docs/principles/index.md)
- Task skills: [`.agents/skills/`](./.agents/skills/)
- Cloud Agent VM gotchas (Node, Playwright, dev server, seeding, limits):
  [docs/contributing/cloud-agents.md](./docs/contributing/cloud-agents.md)
- Dependency bump or audit fix: reuse an open PR, never open a duplicate
  ([rule](./docs/contributing/dependency-overrides.md#dependency-bump-prs))
- Production Cloudflare Workers are CI-only: agents never run `wrangler deploy`,
  `wrangler versions upload`, `wrangler versions deploy`, `wrangler secret put`,
  `wrangler secret bulk`, or `wrangler versions secret bulk` against
  `kody-production` (or any production Worker). Production deploys and secret
  changes go only through `.github/workflows/deploy.yml`
  ([why](./docs/contributing/rollback.md#ci-only-production-deploys)).

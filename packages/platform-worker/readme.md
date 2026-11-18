# kody platform worker

The platform Durable Object lane extracted from the origin `kody` Worker per
[ADR 0034](../../docs/contributing/decisions/0034-origin-owns-no-durable-objects.md):
`MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`,
`RepoSession`, `RepoSessionIndex`, and `StripePlanRefresh`.

The Worker entry module is
[`packages/worker/src/platform-worker.ts`](../worker/src/platform-worker.ts):
the platform lane shares the origin Worker's source tree, import maps, and
pre-bundled generated modules, so this package holds only the deploy
configuration. The entry module is typechecked and tested through the `worker`
Nx project. It also exports `KodyFetchGateway` so MCP `execute` can loopback
outbound fetch from the platform-owned `MCP` Durable Object.

- `wrangler.jsonc` — the committed base config (script name `kody-platform`).
  Deployable configs are generated from it plus the origin Worker's generated
  config by
  [`tools/ci/platform-worker-config.ts`](../../tools/ci/platform-worker-config.ts).
- HTTP is health-only: `GET /__platform/health`.
- Build check: `npm run platform:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
- Official guide markdown deploys upload this script with origin so MCP
  `search({ entity: "guide:{id}" })` matches web `/docs` (`/guides*` permanently
  redirects to `/docs*`).
- Production Durable Object ownership: see the
  [migration runbook](../../docs/contributing/architecture/platform-worker-migration-runbook.md).

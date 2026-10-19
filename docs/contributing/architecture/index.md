# Architecture overview

This folder documents the important runtime architecture for `kody`.

Before making product-level assumptions, read
[`../project-intent.md`](../project-intent.md). The architecture docs describe
how the system works, while the intent doc explains what the project is trying
to become.

## Production worker fleet

Production is four product scripts, the `kody-api` edge, and independent ops
workers. Origin owns **zero** Durable Object classes
([ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md)).

| Script                       | Public surface                         | Owns                                                                                                                                                                         | Binds                                                                        |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `kody-production` (origin)   | `kody.codes`                           | TanStack Start website, MCP HTTP, OAuth, inbound email, queue consumers, `JobsHost`, `KodyApi`, `DynamicWorkerUsageTail`                                                     | Platform DOs, runtime DOs / workflows, `RUNTIME_WORKER`, `JOBS`, `HIGHLIGHT` |
| `kody-platform`              | `/__platform/health` only              | `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`, `KodyFetchGateway`, `DynamicWorkerUsageTail` | Shared D1/KV/R2/AI; runtime DOs for package work                             |
| `kody-runtime`               | `{user}.kody.run`; `/__runtime/health` | `StorageRunner`, `RunLog`, `PackageRealtimeSession`, `DynamicCallableWorkflow`, `KodyFetchGateway`, `DynamicWorkerUsageTail`, `PackageAppRuntimeBridge`                      | Platform DOs, `JOBS`                                                         |
| `kody-jobs`                  | no public hostname                     | `JobManager`, `JOBS_DB`, `kody-scheduled-dispatch`                                                                                                                           | `HOST` → origin `JobsHost`                                                   |
| `kody-highlight`             | no public hostname                     | Shiki tokenizer (`POST /highlight`)                                                                                                                                          | —                                                                            |
| `kody-api`                   | `api.kody.codes`                       | Open API edge: CORS, rate limits, header strip, body cap                                                                                                                     | `KODY_API` → origin `KodyApi`                                                |
| `kody-api-docs`              | `api-docs.kody.codes`                  | Scalar OpenAPI docs UI; proxies live `/openapi.json`                                                                                                                         | HTTPS fetch → `api.kody.codes`                                               |
| `kody-status`                | `status.kody.codes`                    | `StatusStore`                                                                                                                                                                | HTTP probes + `JOBS` service                                                 |
| `kody-nx-cache`              | `nx-cache.kody.codes`                  | R2 `kody-nx-cache`                                                                                                                                                           | —                                                                            |
| `kody-production-d1-backups` | operator-only                          | D1 backup / DR workflows                                                                                                                                                     | R2 `kody-production-backups`                                                 |

Local `npm run dev` attaches origin, platform, runtime, jobs, and highlight in
one Miniflare. Playwright `CLOUDFLARE_ENV=test` is the exception: Durable Object
classes run on the single `kody-test` script with no `script_name`.

UI/blog-only deploys upload origin and skip platform, runtime, and jobs.
Official guide markdown (`docs/guides/`, `packages/worker/src/guides/`) uploads
origin and platform because MCP `search({ entity: "guide:{id}" })` and
`codingGuideGet` bundle those files.

MCP `execute` resolves `KodyFetchGateway` from `ctx.exports` on the script that
owns the `MCP` Durable Object (`kody-platform`). Origin
`POST /__maintenance/execute-smoke` is **origin-only**: it uses origin
`ctx.exports` and returns `scope: "origin-only"`,
`proves: "origin-kody-fetch-gateway"`, and `notMcpExecute: true`. A passing
smoke does not prove MCP execute health. Authenticated MCP execute evidence is a
timestamp-only fleet heartbeat from successful execute completion, shown on
`status.kody.codes` with source and last-verified time. The public card is
recent when that evidence is younger than one hour. Organic traffic alone keeps
the card green. When no organic success landed in the previous minute, the
status worker runs at most one authenticated
`POST /__maintenance/mcp-execute-health` per hour (optional fallback). Public
status reads never trigger that execute. When the status Durable Object's
last-success timestamp is already outside the one-minute skip window, `/` and
`/status.json` refresh `executeEvidence` from origin `GET /health/components`
and persist a newer timestamp (merged with whatever cron or another snapshot
wrote during that fetch) so the next cron can skip the synthetic.

## Core docs

- [Project Intent](../project-intent.md): current scope, goals, and non-goals
  for the project.
- [Request Lifecycle](./request-lifecycle.md): how requests are routed in the
  Worker, including syntax highlighting on code-bearing pages and the short CDN
  cache for anonymous marketing HTML.
- [Onboarding process](./onboarding.md): wizard steps, derived checklist, and
  the optional first-win guide (aligned by
  `packages/worker/universal/onboarding-process.ts`). See
  [Waiting](../../use/waiting.md) for first-use and Discord membership cards.
- [Authentication](./authentication.md): app session auth and OAuth-protected
  MCP auth.
- [Request context](./request-context.md): the one `RequestContext` (org, actor,
  attribution, credential) every request source derives, and lineage for runs
  started by other runs.
- [Authorization](./authorization.md): the one org access check (`authorize`),
  what every surface declares, enablements (who a trigger runs as), and
  site-admin RBAC with its `any`-access exception to per-user isolation.
- [Entitlements](./entitlements.md): per-user plans (`free`, `standard`, `pro`,
  `max`; live DDL defaults and writers use `free`; `max` is a manual-only high
  finite ceiling), finite per-plan resource limits, and the shared
  `assertWithinEntitlement` enforcement helper (`parseStoredPlanName` for reads;
  strict `parsePlanName` for untrusted admin/API input).
- [Open API](./open-api.md): `api.kody.codes`, interactive docs on
  `api-docs.kody.codes`, scoped API tokens, the MCP `api` tool, and the
  CapabilityProxy contract used by local CLI execute.
- [Feature Flags](./feature-flags.md): code-registry flags with D1-backed global
  state, percentage rollouts, and per-user overrides, managed at
  `/admin/feature-flags`.
- [Data Storage](./data-storage.md): what is stored in D1, KV, and Durable
  Objects. The rubric for choosing between D1, a per-user Durable Object, and
  Analytics Engine is recorded in decision record
  [0002 — Data placement](../decisions/0002-data-placement.md).
- [Usage Metering](./usage-metering.md): per-user usage events (including
  Cloudflare-measured Worker Loader CPU and Durable Object duration), the
  `recordUsage()` helper contract, the D1 rollup table, and the usage-state
  campaign machine.
- [Worker startup budget](./startup-budget.md): what counts toward Cloudflare's
  startup CPU limit, how to profile it with `wrangler check startup`, the
  lazy-loading rules for capability domains and heavy libraries, and the
  `worker-startup-time:check` tripwire.
- [Invocation overhead guardrails](./invocation-overhead-guardrails.md):
  per-call platform overhead budgets for the static-first package model (static
  imports zero, keyless package export runs tens of milliseconds), watching
  `kody_usage_events` percentiles per surface, and the PR-level budget
  justification required for any new awaited D1 write on a hot invocation path.
- [Run records](./run-records.md): per-user execution history and logs across
  every runtime surface (`RunLog` Durable Object, `runs` MCP domain,
  `/@<slug>/-/activity`).
- [Runtime worker migration runbook](./runtime-worker-migration-runbook.md):
  ownership of the package runtime lane on `kody-runtime` and the deploy
  invariants later uploads must keep
  ([ADR 0016](../decisions/0016-mono-worker-extraction.md)).
- [Platform worker migration runbook](./platform-worker-migration-runbook.md):
  ownership of remaining platform Durable Object classes on `kody-platform` and
  the deploy invariants that keep origin owning none
  ([ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md)).
- [Jobs worker migration runbook](./jobs-worker-migration-runbook.md): ownership
  of `JobManager` and `JOBS_DB` on `kody-jobs` and the deploy invariants later
  uploads must keep ([ADR 0016](../decisions/0016-mono-worker-extraction.md)).
- [Production rollback](../rollback.md): Cloudflare version rollback vs
  forward-fix on `main` for the five product scripts, including when Durable
  Object or D1 migrations make Path A unsafe.
- [Cleanup after migrations](../cleanup-after-migrations.md): drop leftovers in
  the same change when safe; otherwise open a GitHub issue. Values retirement is
  complete ([ADR 0022](../decisions/0022-retire-values-primitive.md)).
- [Primitives map](./primitives.yaml): stable taxonomy of system primitives and
  invariants for the visual-recap skill
  (`.agents/skills/visual-recap/SKILL.md`). It is not a living feature changelog
  and not derived from source — architecture docs and code remain the truth for
  behavior. Update the map only when adding, removing, or reshaping a primitive.
  Classify PR paths with
  `node .agents/skills/visual-recap/scripts/classify-primitives.mjs`; validate
  with `npm run primitives:check`.
- [Inbound webhooks](./webhooks.md): user-owned `POST /@:username/webhooks/...`
  ingress that dispatches to a bound saved-package export (HMAC verification,
  ack/sync or params input, caller Idempotency-Key, delivery history via run
  records).
- [MCP client servers](./mcp-client-servers.md): user-added remote MCP servers
  Kody connects to as a client (per-user hub Durable Object, OAuth flow, and
  `kody.mcp[...]` capability synthesis). Local-network systems reach Kody the
  same way (outbound MCP under `kody.mcp[...]`).
- [OAuth integrations](./integrations.md): first-class OAuth apps and
  connections in D1 (`user_oauth_apps` / `user_integrations`), including
  operator-provisioned platform (built-in) apps (`platform_oauth_apps`),
  encrypted connection tokens and user-lane client secrets, dual host gates,
  `/connect/oauth`, and `createAuthenticatedFetch`.

## OAuth integration host allowlist

The `createAuthenticatedFetch` helper (and its sandboxed prelude equivalent)
attaches a materialized OAuth bearer token to outbound requests. At that point,
the outbound token is not a `{{secret:…}}` placeholder, so the fetch gateway's
host-allowlist check cannot inspect it. To prevent token exfiltration to
arbitrary hosts:

- Before attaching the `Authorization` header, the helper resolves the
  integration's allowed host set from `requiredHosts` plus the host of
  `apiBaseUrl`.
- If the outbound request URL targets a host **not** in that set, the helper
  throws `IntegrationHostNotAllowedError` without making the network request and
  without including the token value in the error message.
- The reusable enforcement logic lives in
  `packages/worker/src/mcp/execute-modules/integration-host-allowlist.ts`
  (`assertIntegrationHostAllowed`, `getIntegrationAllowedHosts`).

This invariant must hold for any code path that materializes an integration
token and then attaches it to an outbound request. Host-side refresh via
`integrationTokenRefresh` materializes tokens only server-side and returns
metadata. See [OAuth integrations](./integrations.md).

## Source of truth in code

- Origin entrypoint: `packages/worker/src/index.ts` (dev/test and
  fresh/ambiguous production). Steady-state production and every preview origin
  use `packages/worker/src/production-worker.ts` from the generated deploy
  config (`tools/ci/production-resources.ts`, `tools/ci/preview-resources.ts`).
- Platform entrypoint: `packages/worker/src/platform-worker.ts`
- Runtime entrypoint: `packages/worker/src/runtime-worker.ts`
- Jobs entrypoint: `packages/jobs-worker/src/index.ts`
- Highlight entrypoint: `packages/highlight-worker/src/index.ts`
- App request handler: `packages/worker/start/http-entry.ts`
- HTTP protocol services: `packages/worker/start/server/protocol-handlers.ts`
  and `packages/worker/universal/routes.ts`
- Web document routes: `packages/worker/start/routes`
- OAuth handlers: `packages/worker/src/oauth-handlers.ts`
- MCP auth checks: `packages/worker/src/mcp-auth.ts`
- MCP capability catalog: domain modules under
  `packages/worker/src/mcp/capabilities/*/domain.ts`, merged list in
  `packages/worker/src/mcp/capabilities/builtin-domains.ts`, built by
  `packages/worker/src/mcp/capabilities/build-capability-registry.ts`, memoized
  for builtins via `getStaticRegistry()` and resolved per request via
  `getCapabilityRegistryForContext()` in
  `packages/worker/src/mcp/capabilities/registry.ts` (see
  [`../adding-capabilities.md`](../adding-capabilities.md)).
- Workflow runtime hub:
  `packages/worker/src/package-runtime/package-workflows.ts` defines the shared
  `DynamicCallableWorkflow` Cloudflare Workflow used by every runtime context.
  Runtime injection is wired through
  `packages/worker/src/mcp/run-kody-registry.ts` for bundled code and
  `packages/worker/src/package-runtime/package-app.ts` for package apps.

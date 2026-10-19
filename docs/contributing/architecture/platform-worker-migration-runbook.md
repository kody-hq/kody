# Platform worker migration runbook

Production owns the platform Durable Object classes on `kody-platform`.
`transferred_classes` is a one-shot cutover; do not invent a second transfer or
add `deleted_classes` for those names.

This page records current ownership and the invariants later deploys must keep.

How the remaining platform Durable Objects live on the `kody-platform` Worker
(`packages/platform-worker/`), per
[ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md). Later deploys
follow `.github/workflows/deploy.yml`. UI/blog-only uploads skip platform.
Official guide markdown uploads origin and platform.

## Ownership

| Concern                                                                                                                        | Owner                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Website (TanStack Start), blog, official guides, static assets                                                                 | `kody` (origin)                                             |
| MCP HTTP (`/mcp`), OAuth, inbound email, queues                                                                                | `kody` (origin)                                             |
| `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh` | `kody-platform` (origin and runtime bind them cross-script) |
| `StorageRunner`, `RunLog`, `PackageRealtimeSession`                                                                            | `kody-runtime`                                              |
| `JobManager`                                                                                                                   | `kody-jobs`                                                 |
| `APP_DB` / `AUDIT_DB` / KV / R2 / queues / Vectorize / AI                                                                      | Shared resources; each worker binds directly                |

## Invariants

- Do not add another `transferred_classes` row for `MCP`, `McpClientHub`,
  `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`,
  `RepoSessionIndex`, or `StripePlanRefresh`. The `v1` transfer already applied
  on production `kody-platform`. The exact set is protected by
  `tools/ci/durable-object-baseline.json`.
- Never add `deleted_classes` for a transferred class. That destroys data.
- The committed `from_script: "kody"` in
  `packages/platform-worker/wrangler.jsonc` is rewritten by
  `tools/ci/platform-worker-config.ts` to the deployed origin script name
  (`kody-production`) at deploy time. Leave that rewrite in place; do not point
  production at a second source script.
- Preview worker sets (`kody-pr-<n>-platform`) are created fresh with
  `new_sqlite_classes`. Preview cannot rehearse a `transferred_classes`
  migration. Because platform and runtime create their own classes, the preview
  origin (`kody-pr-<n>`) never owns one: `tools/ci/preview-resources.ts` runs
  the same classifier as production against the per-PR script names, uploads the
  slim `production-worker.ts` entry, and strips the origin's Durable Object
  migrations from the generated config. Deploy order is platform (bootstrap
  without runtime references, skipped on a steady fleet) → runtime → platform →
  origin. Only a preview origin created before this topology that still owns
  transferred classes falls back to the full `index.ts` entry.
- Cloudflare rules that made the original transfer valid still apply to any
  future class move: the source script must still exist and still contain the
  migration history that created the class; the destination must export the `to`
  names; existing ids, storage, and alarms move with the class. Those rules are
  why a second transfer or a `deleted_classes` tag for these names is forbidden.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not run wrangler by hand to "finish" a transfer.

`tools/ci/origin-production-deploy-state.ts` classifies the live origin script
before each production origin upload:

- **Steady-state** (current production): platform and runtime own every
  transferred class and origin owns none of them. Origin uploads the slim
  `production-worker.ts` entry. Platform/runtime deploys stay path-filtered and
  do not re-apply the `v1` transfer.
- **Fresh** (no origin script and no transferred namespaces, or origin still
  owns transferred classes while platform and runtime own none): origin uploads
  the full `index.ts` entry first so `new_sqlite_classes` can replay, then
  platform and runtime apply the existing `transferred_classes` tags, then
  origin uploads the slim entry. The bootstrap workflow binding uses
  `kody-production-bootstrap-dynamic-callable-workflows` so it does not collide
  with the runtime-owned name.
- **Ambiguous** (probe failed, mixed ownership, or a missing origin while
  destinations already own classes): origin keeps the full entry. The workflow
  does not bootstrap and does not force a transfer. Bindings for classes origin
  still owns drop `script_name` so requests do not follow a cross-script binding
  to a script that does not have the storage.

When platform sources change on a steady-state script, the workflow deploys
`kody-platform` before origin so cross-script bindings stay valid. That order is
binding and healthcheck hygiene. It does not re-apply the `v1` transfer.

UI/blog-only uploads skip platform, runtime, and jobs. Official guide markdown
deploys origin and platform (MCP bundles those files) and still skips runtime
and jobs, so those Durable Objects are not reset.

Healthchecks: origin `/health`, platform `/__platform/health`, runtime
`/__runtime/health`.

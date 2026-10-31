# Packages and manifests

Repos are Kody's base persisted primitive; a **package** is a repo with the
package extension activated (runtime surfaces, publish checks — see
[ADR 0003](./decisions/0003-repos-as-base-primitive.md)).

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid scoped package name (`@scope/<leaf>`). This is package
  identity. Look up a package by that scoped name (or the name leaf). Use the
  saved-package UUID `package_id` only when the name is not known, or for a
  stable ref. Never pass both. The leaf after `/` is the URL slug. Create flows
  pass the `@owner/leaf` name or the name leaf.
- `exports` — authoritative import/export map. Optional: omitting it means no
  exports, the same as `"exports": {}` (e.g. a data-only package with an app)
- `private` — leftover npm-style field; ignored for catalog listing. Visibility
  is a repo setting (`packageUpdate` `changes.visibility`), default private
- `kody.description` — short public tagline for search/detail (max 200)
- `kody.tags` — search tags
- `kody.category` — optional community browse category (`integrations`,
  `examples`, `productivity`, `apps`, or `utilities`)
- `kody.searchText` — optional longer search text beyond the short description
- `kody.dependencies` — map of direct static saved package dependencies imported
  via `kody:@...`, written as `{ "@scope/package": "*" }`. `*` means the
  dependency's latest published commit, captured when this package publishes.
  Arrays are rejected. Repo checks reject cycles in this graph at publish time,
  and fail closed if a reachable saved package manifest cannot be loaded.
- `kody.credentials` — optional credential slots (`kind`, `provider`,
  `multiple`, `description`); see
  [Credential slots](../use/packages.md#credential-slots-kodycredentials).
  `kind: "secret-provider"` slots name the provider package in `package`
  (resolved at publish by
  `packages/worker/src/credentials/secret-provider-slots.ts`) and are left out
  of mapping consumers through `savedCredentialNeeds`
  (`packages/worker/src/credentials/credential-needs.ts`). Declaring slots does
  not change placeholder resolution. Publish stores the needs closure (own slots
  plus static dependencies' closures) under the `credential-needs` KV key for
  the source and commit
  (`packages/worker/src/credentials/credential-needs-closure.ts`); a publish
  that stored none reads as the package's own slots
- `kody.secretMounts` — optional package-scoped secret mount declarations
- `kody.secretProvider` — optional `{ id }` declaring this package can serve
  that external secret provider. Metadata alone does not bind the provider; see
  [secret providers](./secret-providers.md)
- `kody.app` — optional hosted package app config
- `kody.subscriptions` — optional package-owned event subscriptions
- `kody.emits` — optional package-emitted event topic declarations
- `kody.webhooks` — optional inbound webhook declarations bound to package
  exports (see [`docs/use/webhooks.md`](../use/webhooks.md))
- `kody.jobs` — optional package-owned schedules

The validation schema (`authoredPackageJsonSchema` in
`packages/worker/src/package-registry/types.ts`) is authoritative when this list
and the code disagree.

The package manifest is `package.json`.

## Required package docs

Publish checks require two non-empty root files:

- `README.md` — human-focused (what it does, prerequisites, setup, done-when,
  plus `## Intent`)
- `AGENTS.md` — agent-focused (imports, smoke tests, edge cases)

`runRepoChecks(...)` fails with kind `docs` when either file is missing or
empty. Community install and platform codemods skip this gate so existing
listings stay forkable and migratable. The next author-driven publish must add
both files. See [package-authoring](../guides/package-authoring.md).

## npm dependencies

Saved packages may declare npm runtime dependencies in
`package.json#dependencies` when the dependency is compatible with the
Cloudflare Workers runtime.

Important behavior:

- Kody resolves and bundles saved-package npm dependencies during repo checks
  and publish-time artifact rebuilds.
- Published bundle artifacts are what package exports, jobs, subscriptions, and
  apps execute at runtime.
- External publish flips `published_commit` before the per-target npm bundle
  rebuild finishes. While that rebuild is in flight, invoke may serve the
  previous npm-backed bundle for two minutes, keyed to the published source
  snapshot `createdAt` from finalize (not `entity_sources.updated_at`, which
  also moves on indexed_commit and reconcile writes). After the window, missing
  bundles fail as retryable `artifact_preparation_failed`.
- If a package declares a dependency that the bundler cannot resolve or bundle,
  repo checks fail with the underlying bundling error instead of allowing a
  publish that will only fail later at runtime.
- Undeclared bare package imports on entry points fail the dependencies check
  before `published_commit` advances, including when check-time esbuild is
  deferred. Add them to `package.json#dependencies` or vendor
  `node_modules/<name>` in the snapshot. Unparseable entry source fails the same
  way so publish cannot skip the check.
- An isolate memory or CPU reset during bundle validation is the same class of
  failure: the npm graph does not fit a Worker isolate. The check message points
  at `search({ entity: "guide:heavy_work_offload" })`.
- Runtime execution does not invent a new dependency policy or ask callers to
  choose one. Dependency handling is part of the saved-package pipeline itself.

Contributor guidance:

- Prefer Worker-safe ESM packages.
- Declare runtime dependencies under `dependencies`, not `devDependencies`.
- When debugging dependency issues, verify both `runRepoChecks(...)` and the
  published bundle artifact rebuild path, since both must agree on what the
  saved package can execute.

## Mental model

Think in terms of:

- packages
- package exports
- package apps
- package-owned jobs
- package-owned subscriptions
- package-owned webhooks
- package-owned workflows (declared in runtime code, not the manifest)

The repo is the top-level persisted source; a saved package is the identity of
the activated package extension on that repo.

## Package state model

A saved package is a repo with the package extension activated. Four concepts:

1. **Package source** — Artifacts repo + D1 `entity_sources` projection;
   manifest rooted at `package.json`.
2. **Package config** — owned by the saved package id: `package.json#kody`
   metadata and secret buckets keyed by the saved package id
   (`kody.secretMounts`).
3. **Package storage** — StorageRunner bucket
   `storageId = buildPackageStorageId(packageId)` →
   `package:{encodeURIComponent(packageId)}`, reached via `packageStorage()`
   from every package surface (exports, subscriptions, jobs, apps). Non-secret
   knobs and runtime state live here.
4. **Package jobs** — `package.json#kody.jobs` with schedule/execution metadata
   in D1 `jobs` rows; each run binds
   `job:package-job:{packageId}:{encodeURIComponent(jobName)}` scratch storage;
   package config stays keyed by the saved package id; shared durable data uses
   `packageStorage()`.

## Package exports

`package.json.exports` is the package's callable/importable surface.

- Cross-package imports use the full package name, for example
  `kody:@scope/my-package/export-name`.
- Static `kody:@...` imports are bundled snapshots. During checks and
  publish-time artifact rebuilds, Kody records the imported saved package's
  published commit in bundle dependency metadata. Republishing the imported
  package does not rewrite already-published dependent bundles.
- Literal dynamic imports such as `await import("kody:@scope/pkg/export")` are
  unsupported (use a static import when the name is known at write time).
  Publish checks reject the pattern permanently, and the runtime rewrites the
  call site to a teaching error.
- Direct static `kody:@...` imports are a breaking manifest contract: they must
  be listed in `package.json#kody.dependencies` by package name, for example
  `"dependencies": { "@scope/my-package": "*" }` inside the `kody` object. `*`
  is the only supported version and means latest-at-publish, not a live pin.
  Repo checks fail when a static import is missing from the map or when the map
  contains a package that is not statically imported. Type-only imports do not
  count, and declaration files such as `.d.ts` are treated as type-only. Literal
  dynamic `import("kody:@...")` expressions are not static dependency
  declarations.
- Computed `import(specifier)` is the name-as-data path for caller-owned and
  forked modules. The bundler rewrites non-literal `import(...)` expressions
  through a host `__kodyComputedPackageImport` bridge that loads `kody:@`
  specifiers. Prefer a static import when the name is known at write time.
- `kody:runtime` is a reserved host-external virtual module. The bundler may add
  a placeholder so author code can keep `import { kody } from "kody:runtime"`,
  but published bundle artifacts must not persist the host runtime
  implementation. Execution loaders hydrate the deployed host runtime module
  into every referenced `.__kody_virtual__/runtime.js` path, including nested
  static dependency artifacts and package-app workers.
- `packageStorage()` and `packageSecrets` identity is stamped at bundle time.
  Modules that originate from a saved package (the root source of a package
  build via `rootPackageId`, and statically imported package sources) get their
  `kody:runtime` import rewritten to a per-package virtual runtime module,
  `.__kody_virtual__/package-runtime/<hex(packageId)>.js`, which re-exports the
  shared runtime's public names (an explicit allowlist, never `export *`) and
  overrides `packageStorage` / `packageSecrets` with variants that close over
  the package's immutable id. Unstamped modules rewrite to the same allowlist at
  `.__kody_virtual__/public-runtime.js`. Package files must not import
  `.__kody_virtual__/` directly; the build rejects such import specifiers (and
  manifest / wrangler path values), comments and strings that only name the
  directory still build, and computed `import()` of those paths throws. The
  closure survives esbuild inlining, so per-module identity holds even after the
  graph collapses into one module. Hydration regenerates per-package runtime
  modules from the id encoded in the path, exactly like the shared runtime
  module.
- The stamp routes identity but is not the security boundary. At execution,
  `packageStorage()` bucket access and stamp-aligned secret authority are
  granted only from host-controlled provenance metadata: the run's own package
  context, the `packageId` entries recorded in the bundle's static dependency
  metadata (direct imports plus `transitive` entries reached through a
  dependency's reachable source), and published static dependency artifacts
  installed during hydration. Sandbox-supplied strings never extend the grant
  set, so hand-written source claiming an arbitrary package id is rejected
  (`packageId` on `BundleArtifactDependency`, `collectPackageStorageGrantIds` in
  `#mcp/run-kody-registry.ts`, and `createPackageStorageKodyTools` in
  `#worker/storage-runner.ts`). Cross-user access stays structurally impossible
  because storage runner names are keyed by the calling user's id. Imports
  resolve only in the caller's org, so a package from another org (including
  `@kody/*`) is `communityFork`ed before it is imported. User secrets locked to
  A are usable from A's stamped module when B imports A; B's own code still
  cannot read them. Writes stay fail-closed (`allowed_packages` required).
- The author-facing storage prescription is one rule per context: saved-package
  code always uses `packageStorage()` for the package's own data; ad hoc execute
  has no scratch SQLite helper; another package's data goes through a static
  import or `import(specifier)`. Repo checks fail (the `lint` result) when
  package sources import ambient `storage` from `kody:runtime` with a value
  named import; type-only imports and `.d.ts` files are exempt. The rule runs on
  new session check runs, publishes, and community fork installs —
  already-published artifacts are not re-validated until one of those events.
- Callable exports are resolved from package exports, not from a second Kody
  registry.
- Packages may also export non-callable helper modules and values for reuse.

### Package reuse

The author-facing package-reuse contract is two rules (decision 0037):

1. **Name known when the code is written → static import**
   (`kody:@scope/package/export`). The default from execute and from other
   packages: typed by the pre-exec typechecker, publish-verified by repo checks,
   visible in the dependency graph (`kody.dependencies`, dependents tracking),
   and zero per-call platform cost. Ad hoc execute bundles per call, so static
   imports from execute always see the current published version; snapshot
   staleness only affects package-to-package static dependencies.
2. **Name is data → `import(specifier)`** of a caller-owned or forked module.
   Exactly-once work uses [workflows](../use/workflows.md). External trusted
   clients use inbound webhooks, not author composition.

```ts
import handleEvent from 'kody:@kentcdodds/event-subscriber/handle-event'

await handleEvent({ event })
```

`kody:runtime` always exports `packages` as `null`. Treat any `if (packages)`
branch as dead code and use static `kody:@` imports (codemod `0008`,
[0037](./decisions/0037-no-author-packages-invoke.md)). Computed
`import(specifier)` loads caller-owned modules through a separate host bridge.
Interactive MCP `packageSubscriptionDispatch` is the post-publish subscription
smoke test ([0013](./decisions/0013-synthetic-package-requests.md)), not a
composition primitive.

Exact scoped resolution avoids bare-id collisions. A `kody:@scope/...` target
resolves only to a package in the caller's org. A package from another org,
including `kody:@kody/...`, is not runnable until `communityFork` copies it into
the caller's org.

Literal `import("kody:@...")` is a teaching error: known names are static
imports. Computed `import(specifier)` is the name-as-data path. Exactly-once
work uses workflows. External HTTP callers use inbound webhooks.

Publish checks reject object-only `packages.invoke`, `packages.invokeChecked`,
`packages.check`, and literal dynamic `import("kody:@...")`. Codemods `0002`,
`0006`, `0007`, and `0008` are the mechanical repair path. See
[package codemods](./package-codemods.md).

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package may be opened through the
generic UI runtime and hosted under the package app route.

A package app is a hosted Worker entry running in the package-app isolate:

- package app code belongs to the package repo
- package app entry is declared by `kody.app.entry`. The bootstrap
  (`createAppEntrypointSource`) resolves a fetch handler (a function,
  `{ fetch }`, or a named `fetch` export) and forwards the mount-stripped path.
  Authoring and publish reject `kody.app.runtime`. A leftover field on a
  published snapshot is ignored
- The host uses esbuild defaults unless the package's root `tsconfig.json` sets
  `compilerOptions.jsx` / `jsxImportSource` (mapped onto the bundle for any
  import source). Remix recipes set those to `react-jsx` / `remix/component`,
  remount the Request when the route contract includes `appBasePath`, and pass
  explicit `clientEntry` ids (`kody:app#Name`). A handler that borrows
  `remix/headers` or `remix/html-template` needs none of that
- Frameworks are ordinary package dependencies. The platform does not vendor,
  mount, inject, sniff, or stamp version metadata for Remix (or TanStack,
  Preact, or any other library) onto package bundles; the dirty check for
  artifact reuse is file-content-only
  ([decision 0057](./decisions/0057-no-framework-platform-affordance.md)).
  Bundling asserts that every `node_modules/` path in the bundler file set
  already exists in the package snapshot (`assertNoPlatformSuppliedNodeModules`)
- `kody:runtime` exports `KodyRuntime`, a frozen `{ defaultValue }` object that
  Remix's `RequestContext.get()` returns when nothing called `set()`; the value
  is the module's default export (late-bound to the current run), and the
  per-package stamped runtime module exports its own key bound to that package
- `kody.app.client` (optional) is a browser entry; publish builds it with
  `buildKodyAppClientBundle` into the `app-client` artifact kind (esbuild
  browser platform, `kody:` / `cloudflare:` / `node:` imports rejected) and
  `package-app-assets.ts` serves it under
  `<appBasePath>/_assets/client.<hash>.js` with immutable caching before author
  code runs
- `kody.app.assets` (optional) is a static directory served as-is from the
  published source snapshot under `<appBasePath>/_assets/`; publish checks
  require it to be a populated subdirectory. JavaScript assets carry
  `Service-Worker-Allowed: <appBasePath>/` so a service worker shipped there can
  claim the slash-terminated app mount but never a sibling mount that shares the
  prefix
- `packageContext.assetBasePath` and `packageContext.clientModuleUrl` expose
  those URLs to the fetch handler
- durable package data uses `packageStorage()` (same
  `buildPackageStorageId(packageId)` bucket as other package surfaces)
- Durable Objects / facets are app-only realtime/coordination buckets under the
  package namespace, not the persistence mechanism and not separate saved
  primitives

## Package-owned jobs

Jobs belong to packages.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Schedule/execution metadata lives in D1 `jobs` rows (package-owned config)
- Each job run binds a job-scoped scratch bucket; shared durable data uses
  `packageStorage()`
- Package config stays keyed by the saved package id
- Manifest `enabled` is the create-time default only. Republishing never flips
  an existing job's runtime `enabled` flag (neither on nor off), and does not
  insert or reactivate owner cron enablements for a disabled job. Use
  `jobUpdate` / `enablementEnable` (or a package pause/resume export) to change
  enabled state after create.

Jobs are not their own top-level saved primitive.

## Package-owned subscriptions

Subscriptions belong to packages.

- Define them under `package.json#kody.subscriptions`
- Key the record by event topic, for example `email.message.received`
- Reference a package-local `handler` module
- Optionally include a human-readable `description`
- Optionally include topic-specific `filters`

Example:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Kody normalizes handler paths during manifest parsing and rebuilds published
bundle artifacts for subscription handlers during repo checks and package
publish. At runtime, event dispatch invokes the handler through the package
execution path with package context, package-owned storage, package secrets, and
the host-owned `kody:runtime` module.

Wake discovery prefers a normalized source of truth (each package's
`package.json#kody.subscriptions`) plus a per-user KV cache of the computed
topic→package-id map
(`packages/worker/src/package-invocations/subscription-topic-cache.ts`). A wake
reads that one key; on a miss it scans manifests once, fills KV, and uses the
result. Publish and unpublish bump a generation stamp then delete-and-recompute
the map in the same write path so a failed delete or a late wake write cannot
leave wakes matching a stale projection. Incomplete scans (manifest load
failures) never write the map. There is no TTL — a TTL could hide a newly
published subscription. Do not add a denormalized topic-index table; the
manifest stays authoritative.

The built-in `packageSubscriptionsList` capability is the generic discovery
surface for declared subscriptions. It reads the signed-in user's saved package
manifests and returns scoped package `name`, `package_id`, topic, handler,
description, and filters, optionally narrowed by exact topic.

For user-owned inbound email, `email.message.received` dispatches after an
accepted routed message is stored. Quarantined inbound mail dispatches
`email.message.quarantined` instead (same metadata-first payload, different
topic). The payload is intentionally metadata-first: message id, address
metadata, headers useful for threading, processing status, timestamps, and
attachment metadata. Do not embed parsed bodies or attachment bytes in the
event. Handlers should fetch full bodies or bytes only when needed through
`emailMessageGet`, `emailAttachmentGet`, or the package runtime `email` helper.
Reclassifying a stored message later does not retroactively dispatch either
topic.

For user Activity failures, `run.error.recorded` dispatches best-effort after a
successful run-record write for the owning user. The payload is metadata-first
(run identifiers, truncated error fields, and a trusted `activity_url`); it
omits log lines and the full metadata blob. Subscription-surface failures do not
emit (recursion guard). See
[Package subscriptions](../guides/package-subscriptions.md) and
[Run records](./architecture/run-records.md).

For reconnectable OAuth refresh failures, `integration.auth.failed` dispatches
best-effort from host-side `refreshIntegrationTokens`
(`createAuthenticatedFetch` 401 retry and explicit `integrationTokenRefresh`).
Successful refreshes and successful `/connect/oauth` token persists dispatch
`integration.auth.succeeded`. Both payloads are metadata-first (connection name,
account label, scopes, timestamps, and for failed: reason, optional provider
error fields, and trusted `reconnect_url` / `account_url`; for succeeded:
`source` and a trusted `account_url`); they omit token and secret values. Every
classified attempt emits. Provider HTTP 5xx and missing connections do not emit
failed. See [Package subscriptions](../guides/package-subscriptions.md) and
[OAuth integrations](./architecture/integrations.md).

For saved outbound MCP servers, `mcp.server.disconnected` and
`mcp.server.reconnected` dispatch best-effort from the per-user MCP client hub
when a ready server stays down through two lightweight reconnects, parks in
`authenticating` after token refresh fails, or recovers. Waiting and search
peeks dispatch a queued disconnected episode; they do not wait for an
account-page snapshot. The payload is metadata-first (server id/name/state,
episode id, and a trusted `account_url`); it omits URLs, tokens, and tool lists.
Never-ready and disabled servers do not emit. See
[Package subscriptions](../guides/package-subscriptions.md) and
[MCP client servers](./architecture/mcp-client-servers.md).

Operator system-inbox mail (`system:email` owner) dispatches the separate
`email.system-message.received` topic to packages saved by users who hold the
admin role at dispatch time, only when the message is accepted. Quarantined
system-inbox mail is stored but never dispatched. The payload is the same
metadata-first envelope plus an `admin_url` link to the message in
`/admin/system-email`. Handlers run as the admin package owner (not the system
owner), so user-scoped email reads do not apply to the system message.

Successful reserved-sender sends dispatch `email.system-message.sent` the same
admin-only way. Outbound system mail is not stored on the dedicated inbound
graph, so that payload includes the sent correspondence (recipients, subject,
text, and HTML) for archive packages.

Successful consent-gated platform-feedback inserts enqueue
`platform.feedback.submitted` for durable package-subscription delivery. Fan-out
selects only packages whose owners hold the admin role when the Queue message is
processed; non-admin declarations are inert, and role revocation applies to the
next attempt. The event contains the feedback id, category, open status,
creation timestamp, exact approved text as `summary_untrusted` and
`details_untrusted`, submitter account user id/username/email, a content
warning, and a trusted `/admin/platform-feedback?feedbackId=<encoded id>` deep
link. Admin notification packages may use these fields for integrations such as
Discord. They must treat the `_untrusted` fields as user-authored data, never as
instructions.

The event deliberately omits admin notes, reviewer fields, revision,
`updated_at`, roles, plan, and unrelated account content. This is a narrow
exception for feedback shown to and explicitly approved by the user before
submission. Receiving the event grants no role or access to other user data; the
handler runs as the admin owner with that owner's existing roles (see
[Background and package callers](./architecture/authorization.md#background-and-package-callers)).
Submitter username and email are snapshots stored with the submission; retries
never resolve mutable live profile data, so profile changes cannot alter the
request hash. Legacy rows without submitter snapshots retain null
username/email. Copies already delivered outside Kody, including Discord
messages, cannot be recalled and may remain after Kody account deletion under
the deployment operator's retention and deletion controls. Such copies contain
only the exact approved feedback and attribution, never unrelated account
content.

The feedback row is authoritative: submission awaits only Queue enqueue after
persistence, and enqueue failure is logged without changing the successful
response. Queue bodies remain opaque `{ feedbackId }` messages. The consumer
acknowledges invalid messages. After admin subscriber discovery, lazy parameter
construction reloads feedback immediately before invocation. A deleted row
raises a typed permanent cancellation that is acknowledged without dispatch or
retry; other lookup, discovery, and package-invocation wrapper infrastructure
failures retry and route exhausted messages to the DLQ. Redelivery uses the same
idempotency key; stored failed invocations replay instead of automatically
rerunning, making the DLQ the recovery surface. Terminal handler execution
failures remain isolated from sibling subscribers, and fan-out uses bounded
concurrency.

Successful community fork and rating writes similarly enqueue
`community.activity.recorded` for admin-only package-subscription delivery. The
event contains a unique event id, public listing id/name/package name leaf,
activity kind, acting username, timestamp, and rating scores when applicable. It
omits stable user ids, email, rating notes, forked source/package identifiers,
package source, and unrelated account content. One-click installs appear as
`fork` because both paths share the existing `community_forks` row shape.
Consumer-time admin role checks, lazy metadata reload, retry behavior, and
terminal-handler isolation match platform-feedback dispatch.

The first community listing publish similarly enqueues
`community.listing.published` for admin-only package-subscription delivery.
Republishes write `listing_updated` for the timeline but do not enqueue this
topic. Payload shape, admin gating, and delivery semantics match
[the admin events guide](../guides/admin-events.md#communitylistingpublished-admins);
enqueue failures are logged and never fail `communityPublish`.

A republish that moves the pinned commit delivers `follow.published` and emits
`community.fork.upstream_updated` from the follow pipeline (not the old
fork-only queue). That alias is not admin-only. It reaches each forking
account's own subscribed packages, one event per fork, with the historical
payload. Watching without a fork uses `follow.published` / `follow.pushed`. See
[Package subscriptions](../guides/package-subscriptions.md#followpublished).

Status-page incident open/resolve is a separate admin-only, best-effort path.
The isolated status worker POSTs metadata to
`POST /__maintenance/status-incidents` when `STATUS_INCIDENT_EVENT_SECRET` is
set on both workers. The main worker fans out `status.incident.opened` and
`status.incident.resolved` only to packages whose owners hold the admin role at
dispatch time. The payload is component id, probe detail, ISO timestamps, and
the public `status_url`. It omits probe logs and all user content. There is no
Queue for these topics; sweep polling of `/status.json` remains the backstop
when the secret is unset or the POST fails. See
[Package subscriptions](../guides/package-subscriptions.md).

Fleet package-runtime error-rate elevation is a separate admin-only, best-effort
path. The hourly `usage_aggregation` lane writes an Analytics Engine snapshot
and fans `fleet.package_error_rate.elevated` only to packages whose owners hold
the admin role at dispatch time. The payload is window bounds, per-metric counts
and rates, `status_url`, and `insights_url`. When one account or a few accounts
own the recent-window errors, it also names those usernames and package kody
ids. It omits user ids, package UUIDs, emails, error strings, and all other user
content. There is no Queue for this topic. See
[Admin events](../guides/admin-events.md#fleetpackageerrorrateelevated-admins).

Fleet entitlement crossings are a separate admin-only, best-effort path. The
hourly `usage_entitlement_alert` lane fans `fleet.entitlement.crossed` only to
packages whose owners hold the admin role at dispatch time, once per 80% or 100%
crossing (and per first over-threshold runtime-duration month, unique Dynamic
Worker cost month, or three-of-seven execute-cap train). The payload is stable
user id, username, resource counts, runtime duration, unique-worker days, or
days at the execute cap, and admin URLs. It omits emails, plans, secrets, and
package source. There is no Queue for this topic. See
[Admin events](../guides/admin-events.md#fleetentitlementcrossed-admins).

Verification-mail terminal failures are a separate admin-only, best-effort path.
The first bounce, failure, rejection, or complaint on a signup/verify send fans
`user.email_verification.failed` only to packages whose owners hold the admin
role at dispatch time. The payload is stable user id, username, email, delivery
status (`bounced` / `failed` / `rejected` / `complained`), `class`
(`sender_block` / `other` / `null`), an admin user URL, and `occurred_at`. It
omits SMTP transcripts, tokens, and unrelated account content. There is no Queue
for this topic. See
[Admin events](../guides/admin-events.md#useremailverificationfailed-admins).

Stalled verification sends are a separate admin-only, best-effort path. The
hourly `email_verification_stall_alert` lane fans
`user.email_verification.stalled` only to packages whose owners hold the admin
role at dispatch time when an unverified person account still has `accepted`
after 60 minutes with no Cloudflare lifecycle event. The payload is stable user
id, username, email, `accepted_at`, stall threshold, an admin user URL, and
`occurred_at`. It omits SMTP transcripts, tokens, and unrelated account content.
There is no Queue for this topic. See
[Admin events](../guides/admin-events.md#useremailverificationstalled-admins).

Outbound-mail abuse pauses are a separate admin-only, best-effort path. After
the pause write commits, Kody fans `user.email_outbound.paused` only to packages
whose owners hold the admin role at dispatch time. The payload is stable user
id, username, email, reason (`complained` / `bounced`), bounce threshold when
the reason is `bounced`, an admin user URL, and `occurred_at`. There is no Queue
for this topic. See
[Admin events](../guides/admin-events.md#useremailoutboundpaused-admins).

Hourly MCP auth-denial and shared-domain email-delivery bursts are separate
admin-only, best-effort paths. The `auth_denial_alert` and
`email_delivery_alert` lanes fan `auth.denial.burst` and `email.delivery.burst`
only to packages whose owners hold the admin role at dispatch time. Payloads are
count, threshold, window minutes, insights URL, and `observed_at`. They omit
user identities, tokens, recipients, and message content. There is no Queue for
these topics. See
[Admin events](../guides/admin-events.md#authdenialburst-admins) and
[Admin events](../guides/admin-events.md#emaildeliveryburst-admins).

## Package-owned workflows

Packages declare workflow entrypoints in runtime code, not in
`package.json#kody`. The shared `DynamicCallableWorkflow` hub resolves workflow
targets at runtime, so any package export is callable as a workflow without a
manifest declaration.

Runtime code calls `workflows.create(...)` with the package export plus small
parameters:

```ts
import { workflows } from 'kody:runtime'

await workflows.create({
	exportName: './workflow-run-event',
	runAt: '2026-05-03T12:00:00.000Z',
	idempotencyKey: 'sync-event:2026-05-03T12:00:00.000Z:account-123',
	params: { eventId: 'event-123', accountId: 'account-123' },
})
```

In package runtime contexts (package jobs, subscription handlers, package apps),
`packageId` is resolved from `packageContext`. Outside package runtime
(`execute`, ad hoc execute), pass `packageId` explicitly. See
[Workflows](../use/workflows.md) for the full runtime reference, including the
inline `code` shape.

Kody stores workflow payloads as routing metadata (`userId`, package id, package
name leaf, source id, workflow name, export name, idempotency key, `runAt`/plan
date, and small non-secret params). Do not place secrets, OAuth tokens, full
integration configuration, or full device action payloads in workflow params or
metadata. The package export should look up current secrets/configuration from
normal package runtime helpers when it runs.

Workflow instances dedupe per `(userId, idempotencyKey)`, so repeated planners
can safely attempt to create the same scheduled instance without duplicating it.
The hub workflow sleeps until `runAt`, then invokes the saved package export
through the same package execution path used by package invocations. Workflow
instances are not search results and are not saved as a new top-level Kody
entity.

Publishing a package with a `kody.workflows` block fails fast with:

> Invalid package.json: `kody.workflows` is not a supported field; use
> `workflows.create({ packageId, exportName })` from any runtime context.

Remove the block and call `workflows.create` from runtime code instead.

## Repo-backed workflow

Package source is edited and published through repo-backed flows.

- prefer `repoEditFiles`, `repoApplyPatch`, and related file-level session
  capabilities for package changes
- repo sessions expose a file-level API (write/replace/delete/move, patch apply,
  status, diff, log, commit, restore), not arbitrary shell or git-command
  strings; keep agent-facing guidance aligned with the deployed capability
  schema
- prefer a `repoEditFiles` `write` edit for whole-file replacements (single-file
  job sources, freshly generated package modules, one-line config edits) — it
  avoids the unified-diff context drift that makes `git apply` heredocs brittle
- use `packageGetGitRemote` and `packagePublishExternalPush` when a human or
  autonomous agent should drive a normal git client directly against the
  package's Cloudflare Artifacts repo
- open repo sessions by package identity when possible
- for an existing package, treat the repo snapshot as the durable source of
  truth

## External Artifacts pushes

Saved package source repos are real Cloudflare Artifacts git repositories.
`packageGetGitRemote` mints a short-lived Artifacts token for the canonical
source repo (defaults to **write** when you have write access, otherwise
**read**; explicit `scope` is honored) and returns a plain remote URL,
`git_author` (the signed-in Kody account), and setup commands that use
`http.extraHeader` for secret-bearing credentials and set local git `user.email`
/ `user.name` from that account identity. Pushing with a read remote fails with:
`this remote is read-only; request scope: 'write'`.

After a direct `git push`, `packagePublishExternalPush` resolves the package's
default-branch HEAD, opens a transient repo session checkout at that commit, and
uses `publishFromExternalRef` to run the same package checks before advancing
`entity_sources.published_commit`. Full check-time esbuild is deferred to the
later published artifact rebuild so callable and importable targets are bundled
once with published-artifact semantics (`rootPackageId`). The rebuild skips
esbuild for targets whose reachable inputs and bundler root config are unchanged
versus the previous published snapshot, and copies those artifacts onto the new
commit key so the identity row never points at a hole. Shared modules, stale
captured `kody:@` dependency commits, missing prior artifacts, first publish,
force, and mismatched `already_published` snapshot rewrites still rebuild. Same
tip + current `publishChecksVersion` is a true no-op (skips checks). Same tip
with a missing or older stored checker version re-runs authoring checks,
refreshes the credential stamp, writes the current checks version, and returns
`already_published` with `checks_rerun: true` (no tip move, no follower notify).
Check failures before promotion return the failed checks and do not mutate D1,
KV snapshots, published bundle artifacts, package projections, or vectors. A
rebuild failure after promotion returns `checks_failed` with a bundle check;
re-run the publish capability to repair artifacts. Non-fast-forward external
heads are refused unless the caller passes `allow_force: true`. When
`saved_packages.locked_at` is set, checks still run and the result is `locked`
with an approval URL; `published_commit` does not move until the owner promotes
that commit on the website.

When publish succeeds, `packagePublishExternalPush` decorates the response with
`static_dependents`, a bounded summary of direct saved packages whose published
bundle artifact dependency metadata references the published package.
`already_published` responses include the same summary when the published commit
is available. The stale count compares each dependent artifact's captured
dependency commit to the current published commit. Successful `published` and
`already_published` results also include `phase_timings` (`clone_ms`,
`checks_typecheck_ms`, `checks_bundle_ms`, `rebuild_ms`, `dependents_ms`,
`total_ms`). Omitted keys did not run. `checks_bundle_ms` is omitted when bundle
validation is deferred to rebuild. `dispatched` includes
`phase_timings.total_ms` as time-to-dispatch.

This summary is visibility only. Do not add automatic fanout republishing to the
publish path. Agents should inspect and republish dependent packages only when
the static snapshot semantics matter for the change. Dynamic runtime invocation
through package execution, where available, resolves the current published
target at invocation time and should not force a dependent package republish.

The scheduled reconcile job in
`packages/worker/src/jobs/reconcile-artifacts-pushes.ts` is a safety net for
pushed-but-unpublished commits. Every five minutes it scans a small batch of
stale `entity_sources` rows, compares Artifacts HEAD with `published_commit`,
and calls the same external publish path when they differ. Locked packages are
skipped so reconcile cannot bypass the website gate.
`entity_sources.last_external_check_at` throttles the scan. At 03:00 UTC the job
also asks each checked repo to revoke expired Artifacts tokens through
`revokeStaleArtifactsTokens`.

## Search and discovery

Search returns packages as the saved-entity unit.

Package detail should expose nested exports, nested jobs, tags, and app
presence. Search should not frame exports or jobs as separate top-level saved
entities. The slim `package:{id}` index stays an index; one export contract
opens with the same package entity plus a subpath fragment
(`package:{id}#{subpath}`).

Saved packages carry a user-scoped **`hidden`** flag in `saved_packages` (set
via **`packageUpdate`** with `changes.hidden`). Ranked search excludes hidden
packages by default. The public MCP **search** tool and the **meta** domain
**search** capability both accept **`includeHiddenPackages`**. Exact package
queries recognize user-owned UUIDs, package name leaves, current-origin account
package URLs, and owner-matching hosted package URLs without mixing in semantic
capability results. Hidden exact query matches require the opt-in; known-id
entity lookup by UUID or package name leaf, **`packageList`**, **`packageGet`**,
are unaffected. Hiding is not deletion, community delisting, or entitlement
exclusion. Deletion is `packageDelete` (agents, `confirm_name` matching the
package name) or **Delete package** on the package page (type the package name).

`packageUpdate` is reserved for mutable package settings (`hidden`, and
`locked: true`; unlocking is website-only). Manifest-derived metadata and
projections remain canonical in `package.json` and change only through save or
publish.

# Packages

Repos are Kody's durable home for versioned source; a **package** is a repo with
runtime surfaces activated (see [Repos](./repos.md)). Activation is explicit: a
root `package.json` alone does not make a plain repo a package —
`repoPromoteToPackage` (or creating through the package lanes) does.

A saved package is a repo-backed module rooted at `package.json`. Standard
package fields describe the package surface, and `package.json#kody` holds the
Kody-specific metadata.

Packages are not integrations or MCP servers. See
[Packages, integrations, and MCP servers](../guides/packages-integrations-mcp.md)
when those three look interchangeable.

## Mental model

Think in terms of:

- packages
- package exports
- package apps
- package subscriptions
- package-owned jobs
- package-owned retrievers
- package-owned webhooks

Packages are the saved-entity unit across search, execute, repo editing, and UI
hosting. The package page tabs are **Repo**, **Files**
(`/@username/:name/tree/:ref` — the same URL whether the package is public or
private), and **Settings**. Visibility keeps private source off the public web.
Owner controls (lock, visibility, webhooks, delete) live at
`/@username/:name/settings`. Public listings also expose a read-only
[`.git` clone URL](./community-packages.md#clone-a-public-package-read-only-git).
Inbound HTTP uses [webhooks](./webhooks.md). To let someone use a package
without getting a copy, [grant them access](../guides/package-sharing.md). To
ship Agent Skills with a package, see
[package skills](../guides/package-skills.md).

## Package state model

A saved package is a repo with the package extension activated: repos are the
durable home, packages add runtime. Four concepts make up its state:

1. **Package source** — repo-backed code and manifest rooted at `package.json`
   (Artifacts repos plus D1 `entity_sources` projections). `package.json` is the
   source of truth.
2. **Package config** — configuration owned by the saved package id: manifest
   metadata (`package.json#kody`) and package-scoped secrets (secret buckets
   keyed by the saved package id, mounted via `kody.secretMounts`).
3. **Package storage** — the package's durable StorageRunner (SQLite) bucket,
   reached via `packageStorage()` from `kody:runtime`. This is the durable-data
   primitive for every package surface: exports/invocations, subscriptions,
   retrievers, jobs, and package apps. Non-secret knobs and runtime state live
   here.
4. **Package jobs** — scheduled execution owned by the package
   (`package.json#kody.jobs`): schedule/execution metadata lives in D1 job rows;
   each job run binds a job-scoped scratch bucket; package config stays keyed by
   the saved package id; shared durable data goes through `packageStorage()`.

When to use which:

- Durable package data → `packageStorage()`
- Credentials → package secrets; non-secret knobs → `packageStorage()`
- Scheduled work → a package job
- Per-app realtime internals → app facets (implementation detail, not the
  persistence mechanism)

## `package.json`

Use `package.json` as the source of truth.

Important fields:

- `name` — npm-valid scoped package name (`@scope/<leaf>`). This is package
  identity. Look up a package by that scoped name (or the name leaf). Use the
  saved-package UUID `package_id` only when the name is not known, or for a
  stable ref. Never pass both. The leaf after `/` is the URL slug. Create flows
  pass the `@owner/leaf` name or the name leaf.
- `private` — leftover npm-style field; ignored for catalog listing. Visibility
  is a repo setting (`packageUpdate` `changes.visibility`), default private.
- `exports` — authoritative import/export map
- `kody.description` — short public tagline for search, detail, community
  listings, and share cards (~80–120 characters ideal; max 200). Prefer outcome
  phrasing (“Send transactional email via Resend”) over feature lists; put API
  surface, auth notes, and longer detail in README / Intent / `searchText` /
  export docs
- `kody.tags` — package tags
- `kody.category` — optional community browse category (`integrations`,
  `examples`, `productivity`, `apps`, or `utilities`). Community publish stores
  this on the listing; when it is omitted, Kody infers a category from
  well-known tags such as `github` or `zero-auth`, or files the listing under
  Other
- `kody.searchText` — optional longer search text beyond the short description
- `kody.dependencies` — map of direct saved package names imported through
  static `kody:@...` imports (`{ "@scope/package": "*" }`)
- `kody.credentials` — optional credential slots the package needs (see
  [Credential slots](#credential-slots-kodycredentials))
- `kody.secretMounts` — optional secret mount declarations kept so stale static
  dependents that bundled `packageSecrets.get` still resolve. See
  [Leftover secret mounts](../guides/credentials.md#leftover-secret-mounts). New
  code uses `kody.credentials`, not `packageSecrets.get`.
- `kody.secretProvider` — optional `{ id }` declaring this package can serve
  that external secret provider. Metadata alone does not bind the provider; see
  [Custom secret providers](../guides/secret-providers.md)
- `kody.app` — optional hosted package app config
- `kody.subscriptions` — optional event-topic subscriptions with package-local
  handlers
- `kody.emits` — optional package-emitted event topic declarations
- `kody.webhooks` — optional inbound webhook declarations bound to package
  exports (mint a handle with `webhookUrlMint` and register it with
  `webhookUrlApply`; see [Inbound webhooks](./webhooks.md))
- `kody.jobs` — optional package-owned schedules
- `kody.retrievers` — optional package-owned search/context retrievers

`package.json` is the manifest.

For predictable package resolution, saved packages must use a scoped
`package.json.name`. The leaf segment is the URL slug. The scope is the account
username. Changing your username on `/account` rewrites every saved package to
the new `@{username}/…` name (including same-account `kody:@` imports and
`kody.dependencies`), publishes an automatic update commit per package, and
republishes to Community any public package that was already pinned to that
package's latest commit. Third-party integrations and dynamic invocations that
hard-code a previous `@{username}` scope need updates from their owners.

### Credential slots (`kody.credentials`)

`kody.credentials` names each credential the package needs. Publish validates
the block. A slot does not pick the credential: `{{secret:NAME}}` reads the
secret stored as `NAME` and `{{integration-token:NAME}}` the integration named
`NAME`, with the same package access rules as a package without slots. Name each
slot after the secret or integration the code references. Placeholders fill Key
credentials; opt-in types that a package can declare are described in
[ADR 0068](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md).

```json
{
	"name": "@acme/calendar-digest",
	"exports": { ".": "./index.ts" },
	"kody": {
		"description": "Email a weekly digest of Google Calendar events.",
		"credentials": {
			"GOOGLE": {
				"kind": "oauth",
				"provider": "google",
				"multiple": true,
				"description": "Google accounts whose calendars go in the digest."
			},
			"RESEND_API_KEY": {
				"kind": "secret",
				"provider": "resend",
				"description": "Resend API key that sends the digest email."
			}
		}
	}
}
```

- Slot names start with a letter and use letters, numbers, `.`, `_`, or `-` (max
  64). Prefer naming a slot after its provider (`github`, `resend`); publish
  adds an informational note for a key that is not a provider slug
  (`^[a-z0-9-]+$`) and never fails for it.
- `kind` is optional
  ([ADR 0068 amendment 2026-10-12](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md#amendment-2026-10-12)):
  omit it for any fetch-capable credential for that provider (Key/secret such as
  a PAT, oauth, login); declare it only when a specific shape is needed
  (`secret`, `oauth`, `mcp`, or the opt-in types `url`, `login`, and `signing`).
  When `kind` is omitted, matching accepts any fetch-capable credential for the
  provider; a declared `kind` narrows matching to that kind. `provider` is
  optional and defaults to the key; a second account from the same provider gets
  its own key with an explicit `provider`. `description` is required, never
  affects matching, and says why the package wants access. `multiple: true`
  means the package uses several accounts at once. A typical need looks like
  `"github": { "description": "Read PRs to summarize them" }`.
- Publish rejects any other key or a missing required field and names the slot.
  If a later rule rejects a slot in a version that is already published, the
  package still loads with its other slots.
- Each publish stores the package's needs closure: its own slots plus those of
  the packages it statically imports through `kody:@`, as they were at this
  publish. A key that the package and a dependency declare with a different
  `kind` or `provider` fails the publish and names both; give one a different
  key. Omitting `kind` is compatible with a dependency that declares a
  fetch-capable kind (the declared kind is kept).
- `packageGet` returns that closure as `credentials.needs`, each need with how
  it resolves for you: `status` is `ready` (exactly one credential you can Use
  matches the need's kind filter and provider; `autoPick` names it), `ambiguous`
  (several do), or `unbound` (none). `yourOptions` lists what you could pick
  (name, `org` or `personal` scope, hosts): the matches plus matching-kind
  credentials with no provider, which resolve automatically once their provider
  is set (`credentialUpdate`). Only credentials you can Use are listed, and
  needs inherited from a dependency carry `from`.
- To choose which credential a need uses, an agent calls
  `credentialMappingPropose` with org defaults, your own defaults, or mappings
  for your instance of a trigger. It writes nothing and returns an approval
  link. The mappings apply when you open the link and click Approve, which
  applies them all at once and turns on any trigger they map.
- Slots take no `placement`. Publish rejects one with a message to remove it.
  Published versions that include it load with it ignored. The fetch gateway
  fills `{{secret:NAME}}` and `{{integration-token:NAME}}` anywhere in a request
  (a header, the URL path or query, or a text body) when the request is HTTPS
  and its host is one the secret or integration allows, the same as for a
  package without slots. See
  [Placeholders in `fetch`](./secrets-and-values.md#placeholders-in-fetch).

#### Declare what a stamped package may use

A package whose publish stored a credential stamp may use only the credentials
its `kody.credentials` closure declares. That includes a run by the package's
author. It covers `{{secret:NAME}}`, `{{integration-token:NAME}}`, vault refs
(declare the provider), `credential(key)` / `credentials(key)`, and
`secretJwtSign`. An undeclared use fails with `credential_need_undeclared`,
naming the package and the key to add. A slot with no `kind` covers any of them.
A slot declared `kind: "signing"` also fills `secretJwtSign` and
`{{secret:NAME}}`. Literal `kody.mcp.SERVER` calls and `integrationTokenRefresh`
may use only a declared server or integration name. Slots its imports declare
count too. `credential.named()` is refused. This does not depend on the
`credential-need-enforcement` flag.

A package with no stamp keeps the previous path. Your own unstamped package
needs no declarations: a package in your personal org that is not an unadopted
Community fork and is not internet-visible. When the
`credential-need-enforcement` flag is on, a package anyone else runs may use
only the credentials it declares. The flag stays off until that legacy path can
go away, so unstamped packages keep working as they do today. See
[ADR 0068](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md#amendment-2026-10-16-stamped-packages-fail-closed).

#### Opt-in: credential clients

A package (or ad hoc execute) can ask for a client instead of writing a
placeholder. The client never holds the value: the credential decides where its
value goes, and it is sent only to the credential's hosts over HTTPS.

```ts
import { credential } from 'kody:runtime'

const resend = await credential('RESEND_API_KEY')
await resend.fetch('/emails', { method: 'POST', body: JSON.stringify(email) })
```

- `credential(key)` picks the one credential you can Use with the need's kind
  and provider (an undeclared key is read as a provider in ad hoc code and your
  own unstamped packages). A stamped package may use only a declared key. The
  call rejects with an Error carrying `code` (`credential_unbound`,
  `credential_ambiguous`, `credential_not_found`, `credential_need_undeclared`,
  `credential_denied`, `credential_rate_limited`, `invalid_request`,
  `host_not_allowed`, `insecure_transport`) and `retryWith`, a list of picks to
  retry with.
- The client has `name`, `scope`, `kind`, and `hosts`, plus `fetch` (secret,
  oauth, url, and login credentials), `sign` (signing), or `callTool` (an org
  MCP server). A relative URL resolves against the first host. A header the
  credential places replaces one the code set, and a placeholder in that header
  is never filled. `fetch` follows redirects itself and keeps the credential off
  any other host; an OAuth client refreshes once on a 401. A `url` credential's
  client returns a redirect response as it is instead of following it, and its
  request path and query can't carry placeholders. A 401 or 403 carries
  `x-kody-credential-hint` naming only the credential's shape (for example
  `header Authorization Bearer`).
- `credential.named(name, { scope })` picks by exact name. It works only in ad
  hoc execute and in unstamped packages of your personal org that are not listed
  in Community. A stamped package refuses it.
- The caller picks among several matches with a `credentials` map on `execute`
  (for `code` or `invoke`):
  `{ github: 'work', google: ['work', 'personal'], x: { name: 'work', scope: 'org' } }`.
  A pick's kind must match when the need declares one, and its provider must
  match when both have one. `credentials(key)` returns every pick for the key
  (`[]` picks none on purpose); without a map entry it returns the one match,
  never "all of them". The map is checked before code runs: a key no package in
  an invoked run declares fails the run with `credential_need_unknown`, and in
  ad hoc code it is a warning. A package's `credential(key)` resolves the same
  need the check used, pinned by the entry package. A pick with no provider
  opens with a `hint` to set one. A pick grants nothing; it chooses only among
  credentials you can Use.
- A client works only in the run that opened it. Under `kody execute --local`,
  published `kody:@…` modules and ad hoc / unpublished `--code` / `--file`
  modules both use `credential` / `credentials` from `kody:runtime` with the
  same CapabilityProxy resolution and gateway placement as hosted (secret values
  never enter local workerd). CLI releases before the
  [local credential runtime contract](../contributing/contracts/cli-local-credential-runtime.md)
  lack the host export and fail at import time — upgrade `@kodycodes/cli`.

#### Let app visitors use the owner's credential

An internet-visible app runs as its visitor: the signed-in person, or no one for
a signed-out visitor or someone outside the org. A signed-in member with Use can
still open org credentials they hold; a signed-out visitor and anyone without
Use cannot. A need the app fills for every visitor (a shared database, an email
sender) opts in per slot with `ownerCredentialForVisitors: true`:

```json
{
	"kody": {
		"credentials": {
			"rooms-db": {
				"kind": "secret",
				"provider": "rooms-db",
				"description": "Database the room chart reads for every visitor.",
				"ownerCredentialForVisitors": true
			}
		}
	}
}
```

- The flag takes only `true`; omit it to keep today's behavior. There is no
  package-wide switch, and needs a package imports keep the flag their declaring
  package gave them.
- It changes the capability fingerprint, so adding it to an internet-visible
  package pauses the publish and asks the owner to approve again. The approval
  page says on that credential that visitors can use it through the app, signed
  out or signed in as someone else, without seeing its value.
- In the app's own run, `credential(key)` / `credentials(key)` for that need
  resolve as the person who approved the capability set, with the role they hold
  in the org now, like a trigger acts as its enabler. That applies only while
  the app is internet-visible and serves the approved commit, and only to the
  credentials the approval listed for that need. A private app, or a commit that
  is not the approved one, opens the need as the visitor like any other. When
  the need now resolves to a credential the approval did not list (say, after
  remapping it), or the approver left the org or their account is suspended or
  deleted, it fails with `credential_denied` until an owner approves again.
- Everything else in the run still acts as the visitor: other needs,
  placeholders (`{{secret:NAME}}`), and the app's own sign-in checks.
- Each use by someone other than the approver is rate-limited per app credential
  (every non-owner viewer shares one budget), and fails with
  `credential_rate_limited` past it. Its `credential.resolve` row in the org
  activity log names the app, the approver, and the visitor (or `anonymous`).

To list credential references that match the detect-only scan, run
`repoRunChecks`. Its `credentials` result lists each file with the codemod 0010
pattern labels it matches (for example `- src/index.ts: literal secret`),
without credential names. `repoPublishSession` and `packageSave` repeat that
list in their output, and `packagePublishExternalPush` includes the result in
`checks`. It never fails a check or blocks a publish. The labels are described
in
[package codemods](../contributing/package-codemods.md#0010-detect-legacy-credential-patterns).
When the list is shown, it may end with optional credential types that fit
placeholders the list did not already cover with a declared slot: a Key with an
inject for header or query placeholders; an OAuth connection's `credential(key)`
for an integration token sent as `Authorization: Bearer`; a `url` credential for
path or whole-URL placeholders; a `login` credential for a password, refresh
token, or client secret field on a login or token exchange; and a `signing`
credential for `secretJwtSign` or signature keys. They are suggestions only,
without credential names; nothing is suggested for a placement no type fits,
including basic auth that names two secrets.

### npm dependencies

Saved packages may declare runtime npm dependencies in `package.json`
`dependencies` and import them directly when they are compatible with the
Cloudflare Workers runtime.

- Kody bundles those dependencies for package exports, package apps,
  package-owned jobs, and package subscription handlers.
- Dependency resolution happens during package checks and publish-time artifact
  rebuilds, not by ad hoc package installs during normal execution.
- If a declared dependency cannot be resolved or bundled, package checks fail
  with the bundling error instead of allowing a publish that only fails later at
  runtime.
- If bundle validation exceeds the isolated check runner's memory or CPU limits,
  the usual cause is the npm graph, not the package source. Keep the package as
  a thin orchestrator and offload that work; see
  [Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md).
- After changing `dependencies`, republish the package so Kody can rebuild the
  published runtime bundle artifacts that execution paths use.

Do not rely on `devDependencies` for saved package runtime code. Only
`dependencies` are treated as part of the runtime package surface.

See Cloudflare's
[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
for runtime details. Useful starting points include `p-retry`, `mailparser`,
`remark` / `mdast-util-to-markdown`, and `googleapis`; this list is not
exhaustive.

## Package exports

`package.json.exports` is the package's callable and importable surface.

- Cross-package imports use the full package name such as
  `kody:@scope/my-package/export-name`. Static import is **the default for
  package reuse** — from execute and from other packages — whenever the target
  package's name is known when the code is written. Static imports are typed,
  publish-verified, dependency-graph-visible, and add zero per-call platform
  cost.
- **Imports resolve only in your org.** A package from another org (including
  the public community packages from the `@kody` org) cannot be imported from ad
  hoc `execute` or from a saved package, even with a grant. Publish checks
  reject a static import or `kody.dependencies` entry for another org's package,
  and execute fails the same way. Fork the package into your org
  (`communityFork`) and import that copy.
- Static `kody:@...` imports in saved package code are bundled into published
  runtime artifacts as snapshots of the imported package's published bundle.
  Republishing the imported package does not change already-published
  dependents; they keep using the bundled snapshot until they are republished.
  Ad hoc execute code bundles per call, so static imports from execute always
  see the current published version.
- Prefer a static import when the name is known at write time. Use
  `import(specifier)` only when the package name is data. See
  [Package reuse](#package-reuse).
- Every direct static `kody:@...` import must be declared in
  `package.json#kody.dependencies` using the imported package name, for example
  `"dependencies": { "@scope/my-package": "*" }` inside the `kody` object. `*`
  means the dependency's latest published commit, captured when this package
  publishes. Package checks fail when static imports and declarations differ.
  Type-only imports do not count, and declaration files such as `.d.ts` are
  treated as type-only.
- When the target package is not known until runtime, use
  `import(packageSpecifier)` for a caller-owned or forked module.
- `kody:runtime` is always host-owned and request-scoped. Static imports such as
  `import { kody } from "kody:runtime"` stay valid, but saved package artifacts
  do not persist Kody's runtime implementation; execution always uses the
  deployed host runtime.
- Exports are normal modules. They may expose a default export, named exports,
  or both.
- Direct package invocation calls the resolved module's default export when that
  export is a function. Importing a package from `execute` or another package
  can use any named exports that the module provides. A named-only export still
  publishes; invoking it directly fails with an error that names the entry file.
- Packages may also export non-callable helper modules and values for reuse.
- Publish typecheck is opt-in through a root `tsconfig.json`. With one, publish
  fails on TypeScript errors in every `.ts` / `.tsx` file reachable from exports
  (including their `types` targets), jobs, subscription handlers, and
  retrievers, using that config's compiler options (TypeScript defaults to
  `strict`). The check has no `node_modules`, so bare imports (npm packages,
  `remix/*`, `kody:@…`, `node:*`) are typed as `any`; bundling still verifies
  that they resolve. Without a `tsconfig.json`, publish only checks that job,
  subscription, and retriever entrypoints default export a function, and the
  typecheck message says that source files and exports are not typechecked.
- Add JSDoc to every public export. Search Purpose comes from that JSDoc;
  missing comments fall back to `Package export.` See
  [Export JSDoc](../guides/package-authoring.md#export-jsdoc) in the package
  authoring guide for the done criteria (`@param`, `@returns`, and an `@example`
  that imports `kody:@scope/id/export` and calls it). When helpful, point the
  export at a `types` file and put the JSDoc there. Package search detail and
  `packageGet` surface package descriptions, export descriptions, function
  signatures, JSDoc, type definitions, and FYI metadata for associated
  package-scoped secrets (names and `package_id`, never values). Search
  `package:{id}#{subpath}` is the agent-facing door for one export contract.
  `packageGet` returns the full export array and secret FYI. `packageGet` does
  not return `README.md`, `AGENTS.md`, or source files. Open one file with
  `package:{id}#{path}` (`#L165`, `#L165-L180`, or a Markdown heading slug). For
  the tree or edits, open a repo session (`repoOpenSession` + `repoReadFile`,
  same fragments on `path`) or clone with `packageGetGitRemote`.

### Package reuse

Package reuse follows two rules:

1. **Name known when the code is written → static import.** Use
   `import fn from 'kody:@scope/my-package/export-name'` from execute and from
   other packages. This is the default.
2. **Name is data → `import(specifier)`** of a caller-owned (or forked) module.
   Exactly-once work uses [workflows](./workflows.md), not a second invoke
   primitive.

```ts
import handleEvent from 'kody:@kentcdodds/event-subscriber/handle-event'
import profile from 'kody:@kentcdodds/google/profile'

const result = await handleEvent({ event })
const account = await profile({})
```

Declare every static `kody:@` import in `package.json#kody.dependencies`.
Imports resolve only in your org; `communityFork` another org's package first.
`packageStorage()` on a static import reaches the declaring package's bucket.

Interactive MCP `packageSubscriptionDispatch` is the post-publish subscription
smoke test, not a composition primitive. External trusted clients that must call
a named export over HTTP use inbound webhooks: declare one webhook per export,
mint a handle with `webhookUrlMint`, register it with `webhookUrlApply` when a
provider needs the URL, and POST JSON (`inputMode: "params"` and
`Idempotency-Key` for first-party clients). See
[Inbound webhooks](./webhooks.md).

Scoped resolution is exact: `kody:@kentcdodds/google` selects that package only
when it belongs to the caller's org. A package from another org, such as
`kody:@kody/google`, is not runnable until you `communityFork` it into your org.
To run someone else's live package, they
[grant you access](../guides/package-sharing.md) and you connect to their org.

## Package storage

Every saved package owns one durable storage bucket in the org that owns it
(`storageId = package:{encodeURIComponent(packageId)}`), reached via
`packageStorage()` from `kody:runtime`. Every member, job, and app of that org
reads the same bucket. One rule per context:

- **Writing a saved package?** Use `packageStorage()` for the package's own data
  — from package apps, exports, subscriptions, jobs, and workflows. Retrievers
  can only read granted buckets.
- **Writing ad hoc `execute` code?** Persist durable state from a saved package
  with `packageStorage()`, or statically import the owning package's export. Ad
  hoc execute has no scratch SQLite helper.
- **Touching another package's data?** Statically import that package's export
  (`import fn from 'kody:@scope/package/export'`) so its stamped
  `packageStorage()` does the reading and writing.

`packageStorage()` returns `get`/`set`/`list`/`sql`/`delete`/`clear`/`id`,
writable except in retriever runs, always bound to the declaring package's own
bucket no matter where the code runs:

- In the package's own export/invocation runtime it is the only way to reach the
  package bucket.
- In package apps and jobs it reaches the same shared package bucket. Keep
  run-scoped state in that bucket under run-scoped keys.
- When the module is statically imported (`kody:@scope/package/export`) into an
  ad hoc `execute` call or into another package, each module reads and writes
  the bucket of the package it came from, in the calling user's account. Grants
  are per-bundle, not per-module: statically importing a package grants the
  whole bundle read/write access to that package's bucket, so treat static
  imports of unadopted community forks as a trust decision (adopt after review).

```ts
import { packageStorage } from 'kody:runtime'

export default async function listItems() {
	const bucket = packageStorage()
	const result = await bucket.sql('select name from items order by name asc')
	return result.rows.map((row) => row.name)
}
```

`sql(...)` returns at most 1000 rows and sets `truncated: true` when more
matched. Page large reads with `LIMIT`/`OFFSET` (or a keyset). Mutating
statements that yield rows (`INSERT`/`UPDATE`/`DELETE … RETURNING`) still finish
the write when truncated — only the returned row list is capped. A scan of at
least 1,000,000 rows is allowed, metered, and reported on `warning`; a single
read stops after 1,000,000,000 rows examined. See
[Execute → Storage](./execute.md#storage) for the full result shape.

`packageStorage()` identity comes from the bundler, not from source code: the
publish pipeline stamps each module with the saved package it originated from,
and execution grants bucket access only from that recorded provenance — the
running package itself and the packages the bundle statically imported, directly
or through another imported package's export. Hand-written code cannot claim
another package's id to read its bucket. Two consequences:

- Inline `execute` code has no package provenance, so `packageStorage()` throws
  an actionable error there. Statically import the owning package's export.
- When A's export statically imports B, importing A is enough: B's code keeps
  B's bucket. You do not also import B. Only files reachable from the export you
  import count, so A's unrelated exports grant nothing.

User secrets follow the same stamp. An export that reads a secret locked to its
declaring package (or declared in that package's `kody.secretMounts`) keeps that
authority when another package or ad hoc execute statically imports it. The
importer does not need its own `allowed_packages` grant. The importer's own code
still cannot read that secret, including by passing the declaring package's id
to `kody.packageSecretGet` / `Has`. See
[Package approval](./secrets-and-values.md#package-approval).

### Ambient `storage` is not a `kody:runtime` export

Repo checks fail when package source imports ambient `storage` from
`kody:runtime` (type-only imports and `.d.ts` files are exempt). Use
`packageStorage()` instead. Ad hoc execute has no scratch SQLite helper.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package is hosted under the package
app route.

Production-hosted package apps run on per-user subdomains of Kody's separate
`kody.run` domain (`https://{username}.kody.run/packages/<package-name>/...`),
not on the signed-in app origin. Opening an app from Kody performs a short-lived
session handoff to that subdomain. Package author JavaScript cannot use the
first-party `kody_session` cookie or call authenticated Kody pages as the
signed-in user.

Package app URLs follow the mount contract: on a subdomain the public path is
`/packages/<package-name>/<path>` (the username lives in the hostname; the
segment is the package name leaf). Kody strips that mount before forwarding, so
every entry sees `/<path>` and root-relative links such as `/audio/123` escape
the app; build in-app links, redirects, shared links, email links, and OAuth
callbacks against `packageContext.hostedUrl` and `packageContext.appBasePath`
(derived from the serving username and package name leaf —
`/packages/<package-name>` on a subdomain, `/@username/packages/<package-name>`
when served inline in non-production). A Remix recipe that prefixes its route
contract remounts the Request in the entry. See
[Package app routing](../guides/package-authoring.md#package-app-routing) for
the authoring example, and [Package apps](../guides/package-apps.md)
(`guide:package_apps`) for the fetch contract, Remix recipe, session handoff,
`packageAppFetch`, asset URLs, and lean forks. Other saved-package runtime
surfaces may omit these app-specific fields.

Use the package app model when the package needs:

- interactive UI
- browser-side forms
- hosted callback URLs
- package-owned backend behavior

When a package app depends on OAuth, saved secrets, or a third-party API, run
the integration bootstrap first: use `search` for the saved integration or
secret reference, open `search({ entity: "guide:integration_bootstrap" })`, and
complete a minimal authenticated `execute` smoke test before treating the app as
ready.

A package app is a hosted Worker entry:

- app code lives in the package repo
- the entry module is declared by `kody.app.entry` and default-exports a fetch
  handler (a function, `{ fetch }`, or a named `fetch` export). The host strips
  the app mount before forwarding. There is no runtime field; publish rejects
  `kody.app.runtime`. A leftover field on a published snapshot is ignored. Remix
  is a recipe (`guide:package_apps#remix-recipe`): declare `remix` in
  `dependencies` like any other package; the platform does not supply frameworks
- Kody's runtime is available from `kody:runtime` (`packageStorage()`,
  `packageSecrets`, `kody`, `createAuthenticatedFetch`, `workflows`, and
  `packageContext`). Remix controllers can also `get(KodyRuntime)`
- an optional browser entry is declared by `kody.app.client` (a path, or
  `{ entry, externals }` for import-map packages); Kody bundles it for the
  browser on publish and serves it as a fingerprinted, immutable module under
  `<appBasePath>/_assets/`, with the URL on `packageContext.clientModuleUrl`
- an optional static directory is declared by `kody.app.assets` and served as-is
  under `packageContext.assetBasePath` (see
  [Browser client and static assets](../guides/package-apps.md#browser-client-and-static-assets))
- durable package data uses `packageStorage()` — the same shared package bucket
  as exports and jobs
- internal Durable Objects or facets are app-only realtime/coordination details
  layered under the package namespace, not the persistence mechanism and not
  separate saved primitives

## Attached MCP servers

Enabled MCP servers from `/@<slug>/-/mcp-servers` are available as
`kody.mcp["name"]` in execute and in package runtimes that build caller context:
package apps (when capabilities or nested package imports need them), package
subscription handlers, package-owned jobs, workflows, and webhook delivery.

## Package subscriptions

Package subscriptions let a saved package react to built-in Kody event topics.
Define them under `package.json#kody.subscriptions` as a record keyed by topic:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail.",
				"filters": {
					"inbox": "support"
				}
			}
		}
	}
}
```

Each subscription has:

- `handler` — required package-local module path for the event handler
- `description` — optional human-readable purpose surfaced in package detail and
  subscription listings
- `filters` — optional topic-specific metadata reserved for event dispatchers

Subscription handlers run as package runtime modules with the signed-in package
user, package-owned storage via `packageStorage()`, package context, secrets,
and `kody:runtime` helpers. Published bundle artifacts are rebuilt for
subscription handlers during package checks and publish, just like exports,
jobs, and apps.

Use the built-in `packageSubscriptionsList` capability to discover the signed-in
user's saved package subscriptions, optionally filtered by exact topic. This is
the generic discovery step before building fan-out, debugging why an event did
or did not dispatch, or checking which packages subscribe to
`email.message.received`, `run.error.recorded`, `integration.auth.failed`,
`integration.auth.succeeded`, `mcp.server.disconnected`,
`mcp.server.reconnected`, or admin-only topics such as `status.incident.opened`,
`fleet.package_error_rate.elevated`, `fleet.entitlement.crossed`,
`auth.denial.burst`, `email.delivery.burst`, `user.created`, `user.deleted`,
`user.email_verification.failed`, `user.email_verification.stalled`,
`user.email_outbound.paused`, and `email.system-message.sent`. After publish,
smoke-test one declared handler from interactive MCP with
`packageSubscriptionDispatch`
([Synthetic event dispatch](./synthetic-event-dispatch.md)). Reuse another
package with a static `kody:@` import ([Package reuse](#package-reuse)).

For accepted stored inbound email, the topic is `email.message.received`.
Quarantined inbound email dispatches `email.message.quarantined` instead. Both
payloads are metadata-first: handlers receive the stored message id, recipient
and sender metadata, timestamps, processing status, and attachment metadata.
Fetch parsed bodies or attachment bytes only when needed with `emailMessageGet`,
`emailAttachmentGet`, or the `email` helper from `kody:runtime`. `email.reply`
refuses a quarantined message (`quarantined_inbound_reply`) until
`emailMessageClassify` releases it. Operator system-inbox mail dispatches the
separate `email.system-message.received` topic to packages saved by admin users
when the message is accepted (quarantined system mail is stored but not
dispatched); its payload adds an `admin_url` link to the message in the admin
interface. Successful operator sends from reserved system senders dispatch
`email.system-message.sent` with the sent correspondence (recipients, subject,
and bodies) so an admin archive package can record mail that did not go through
a utility wrapper. See [Email primitives](./email-primitives.md) for the full
payload shapes.

When a run in your Activity finishes with an error, Kody dispatches
`run.error.recorded` to your packages that declare that topic. The payload is
metadata-first (run id, surface, identifiers, truncated error fields, and an
`activity_url` deep link). Fetch logs and full detail with `runGet` when needed.
See [Activity](./activity.md) and the
[package subscriptions guide](../guides/package-subscriptions.md).

When host-side OAuth token refresh fails with reconnectable caller state, Kody
dispatches `integration.auth.failed` to your packages that declare that topic.
Successful refreshes and successful `/connect/oauth` persists dispatch
`integration.auth.succeeded`. Both payloads are metadata-first (connection name,
account label, scopes, timestamps, and for failed: reason, optional provider
error fields, and trusted `reconnect_url` / `account_url`; for succeeded:
`source` and a trusted `account_url`). Every classified attempt emits; notifier
packages store working ↔ failed in package storage if they want edge-triggered
pings. See the
[package subscriptions guide](../guides/package-subscriptions.md).

When a saved MCP server leaves the ready state and stays down after a
lightweight hub retry — or parks in `authenticating` after a prior ready because
token refresh failed — Kody dispatches `mcp.server.disconnected`. Waiting and
search peeks dispatch that pending event; they do not wait for an account-page
snapshot. Recovery to ready dispatches `mcp.server.reconnected` with the same
episode id. The payload is metadata-first (server id/name/state, `account_url`).
See the [package subscriptions guide](../guides/package-subscriptions.md).

Artifacts-backed plain repos and packages also emit `repo.pushed`,
`repo.created`, and `repo.deleted` when Cloudflare Artifacts reports those
lifecycle events. Session workspace branch pushes (`sessions/<id>`) and publish
git-notes (`refs/notes/commits`) do not fan out. See [Plain repos](./repos.md)
and the [package subscriptions guide](../guides/package-subscriptions.md) for
payloads and the distinction between live HEAD and package publish.

## Package webhooks

Inbound HTTP webhooks are declared under `package.json#kody.webhooks` and bound
to a package export. Declaring a webhook does not open ingress — mint a handle
with `webhookUrlMint` first, then `webhookUrlApply` to register a destination
(`type: "http"` with `{{webhookUrl}}`; GitHub repo hooks use the Hooks API over
the same path). Full contract, signature examples, and payload shape:
[Inbound webhooks](./webhooks.md).

## Package-owned jobs

Recurring schedules belong on a saved package:

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Schedule and execution metadata are package-owned config (D1 job rows keyed to
  the package)
- Each job run binds a job-scoped scratch bucket
  (`job:package-job:{packageId}:{encodeURIComponent(jobName)}`); that bucket is
  run-local
- Package config (secrets and manifest mounts) stays keyed by the saved package
  id
- Shared durable data goes through `packageStorage()`
- Each run, including `jobRunNow`, gets a 5-minute sandbox budget on every plan,
  including package exports the job imports. Outbound `fetch` keeps its own
  5-minute deadline and 60s idle timeout

Jobs are part of the package definition. Deferred one-shot work uses
`workflows.create({ runAt })` from `execute` or package runtime — see
[Workflows](./workflows.md).

`jobUpdate` adjusts metadata on an existing job: schedule, timezone, enabled
state, kill-switch state, params, `expires_at` (UTC ISO auto-disable; null
clears). Jobs keep name and source in the package repo — change, add, or remove
the job entry there and publish. `jobRunNow` triggers an existing package job
immediately for debugging. When `expires_at` is reached the platform stops
scheduling and auto-disables the job.

## Save and edit packages

When creating a package or publishing a new version, include non-empty root
`README.md` and `AGENTS.md`. `README.md` is human-focused (what it does,
prerequisites, setup, done-when) and includes a concise `## Intent` section.
`AGENTS.md` is agent-focused (imports, smoke tests, edge cases). Publish checks
fail if either file is missing or empty. Already-published packages keep running
as published; the next author-driven publish requires both files. This is a
file-layout contract, not a manifest field. Ask the user if intent is unclear,
and update Intent only when you are confident the goal changed or the user
expands the scope.

Use:

- `packageGetGitRemote` and `packagePublishExternalPush` when you have a normal
  git client: mint a remote (pass `create: true` with the new `@scope/leaf`
  name, or the name leaf, to register a stub package first), clone, edit, push,
  and then ask Kody to reconcile the pushed Artifacts HEAD. Existing packages
  use the scoped name, or `package_id` when the name is not known.
- `packageSave` to create or replace a saved package from a complete UTF-8 text
  file set when no local git client is available
- `search({ entity: "package:{id}#{subpath}" })` for one export's import
  specifier, types, and execute snippet; `packageGet` and `packageList` for
  saved package metadata (full export array, secret FYI). They do not return
  files. For `README.md`, `AGENTS.md`, and source, open a repo session
  (`repoOpenSession` + `repoReadFile`) or clone with `packageGetGitRemote`
- `packageDelete` to permanently remove a saved package the owner typed the name
  of (`confirm_name` must match the package name)
- `packageUpdate` to change mutable package settings such as hidden search
  discovery state or to lock publishes (`changes.locked: true`). Unlocking is
  website-only.
- `repoOpenSession`, `repoReadFile`, `repoEditFiles`, `repoApplyPatch`,
  `repoCommit`, `repoRunChecks`, and `repoPublishSession` to inspect, edit,
  validate, and publish repo-backed package source through the file-level
  session API

### Platform maintenance migrations (codemods)

When the platform's package API changes, Kody may migrate your published package
source with a **package codemod**: a versioned, deterministic, code-reviewed
transform that ships in the open-source repository. An applied codemod runs the
normal checks, records a `codemod(<id>): ...` commit in your package's git
history, keeps a revert snapshot, and dispatches a `package.codemod.applied`
event your packages can subscribe to. Unlocked packages also advance
`published_commit`. Locked packages still receive the commit on HEAD so you can
review and promote it later; they do not skip the transform. Ambiguous matches
are never rewritten — they surface as findings for you instead. What this does
and does not expose to deployment admins is covered in
[Privacy → Platform maintenance](./privacy.md#platform-maintenance-package-codemods).

## Hidden packages

Use **`packageUpdate`** with the scoped name (or **`package_id`** when the name
is not known) and **`changes: { hidden: true }`** to hide a package from
ordinary ranked search. Set **`hidden: false`** inside `changes` to show it
again. The result includes the persisted package summary so callers can verify
the new state.

`packageUpdate` only accepts mutable settings. Canonical metadata including
name, description, tags, app presence, and source projection remains derived
from `package.json` and changes through save or publish.

Hiding is a discovery preference, not deletion. The package stays saved,
executable, and editable. Hiding is separate from **visibility**
(`packageUpdate` `changes.visibility`, which lists or unlists the catalog) and
from entitlement or access grants.

## Delete a package

Deleting a package removes it from the account. It is permanent.

Use:

- The **Delete package** control under `/@username/{package-name}/settings`. A
  modal asks you to type the package name to confirm.
- **`packageDelete`** with the scoped name (or **`package_id`** when the name is
  not known). Show the owner the package name and what will be destroyed, wait
  for them to type that name, then pass **`confirm_name`** matching the package
  name exactly (`package.json` `name`, for example `@you/my-package`). The
  capability refuses the delete and names the expected value when `confirm_name`
  is missing or wrong.

Delete removes the package from discovery, stops its jobs, clears package
storage and package-scoped secrets, and unlists a public catalog entry if one
exists. Artifact repos are cleaned up best-effort. Existing forks keep their
copies.

Hiding and making a package private are not deletion. Use those when the package
should stay saved.

**`packageList`** and **`packageGet`** return a **`hidden`** boolean on each
package summary. Ranked **search** excludes hidden packages unless the caller
passes **`includeHiddenPackages: true`**. Known-id **`entity`** lookups still
resolve hidden packages.

## Publish lock

A package with a **`locked_at`** timestamp on its
`/@username/{package-name}/settings` page (and on `packageList` / `packageGet`)
keeps serving its current published tree. Agents and the five-minute reconcile
job cannot advance `published_commit`. Use **`packageUpdate`** with
**`changes: { locked: true }`** to lock a package. Agents cannot unlock. If an
agent needs the package unlocked, it should send the owner to
`/@{username}/{package-name}/settings` so they can click the lock icon.
`packageUpdate` rejects **`changes.locked: false`** and returns that URL.

When an agent pushes or saves a locked package, the commit still lands on
Artifacts HEAD. Publish tools then return **`locked`** with an
**`approval_url`** that names that commit:
`/@{username}/{package-name}/approve-publish?commit=<sha>`. `<sha>` is the full
40-character SHA-1 object id. A shorter prefix is rejected with "Use the full
commit SHA (40 characters)". Opening that URL shows a file-by-file diff of the
current published tree versus that commit. Clicking **Promote this commit** runs
the real publish (checks, bundle artifacts, projections) for that SHA. Promoting
one commit does not unlock the package.

Unlocked packages use the same review page. When default-branch HEAD is newer
than the last publish, owners see **Publish changes** on the Repo tab and a
**Publishing** panel on Settings. Both open
`/@{username}/{package-name}/approve-publish?commit=<sha>`, where `<sha>` is the
full 40-character SHA-1 of the resolved default-branch HEAD, to publish with
**Publish HEAD**. Visitors may still see a non-interactive status when HEAD is
ahead. The five-minute reconcile job still auto-publishes unlocked packages;
this page is the explicit website path.

Once a package is listed, publishing or promoting advances the public community
listing with the runtime — see
[Listing vs publish and promote](./community-packages.md#listing-vs-publish-and-promote).
`packagePublishExternalPush` may still include a `listing` hint if auto-sync has
not caught up yet.

Fleet package-codemod apply for `head-and-published` codemods does the same HEAD
write on locked packages: the transform commits and pushes so you can review it
the next time you publish. It does not skip locked packages, and it does not
move `published_commit`. Codemods with `applyMode: 'published-only'` (today:
`0012`) finalize `published_commit` even when locked (`allowLockedPublish`). If
that leaves pending HEAD as a sibling of the new published tip, **Publish HEAD**
/ approve-publish still promotes that commit (`allowForce` with the owner click
as overwrite confirmation).

When a provider token is coarser than the job — Gmail has `gmail.send` but no
drafts-only scope — the lock is the real grant. Worked example:
[Gmail drafts without send](../guides/locked-gmail-drafts.md).

Publish lock does not shrink an OAuth token or an MCP connector. To keep a
connected MCP server off execute and other packages, lock the **server** to this
package instead:
[Lock an MCP server to a package](../guides/locked-mcp-server.md).

## Approval when credential needs change

An **internet-visible** package pauses a publish whose credential needs change,
even when it is not locked. Private packages publish without that pause; turning
internet-visible on still goes through
[Approval when a package goes internet-visible](#approval-when-a-package-goes-internet-visible),
which lists declared credentials. A change is a need key the new needs closure
adds, or a key whose `kind`, `provider`, or `multiple` changes. A dependency can
cause it: the closure includes the needs of the packages it statically imports.
Dropping a need, editing a description, and a package's first publish never
pause.

A paused publish keeps the previously published commit serving and is never
published again automatically. A paused `repoPublishSession` or `packageSave`
leaves Artifacts HEAD on the published commit and keeps its session, which holds
the paused commit until approval; an idle session is swept after seven days, so
publish again then. A pushed commit (`packagePublishExternalPush`) is already on
HEAD. `repoPublishSession` and `packagePublishExternalPush` return
**`approval_required`** with `pending_commit`, `credential_need_changes`, and an
**`approval_url`**; `packageSave` fails with the same message and URL. The URL
opens `/@{username}/{package-name}/approve-capabilities`, the package's one
approval page. Its **Waiting for your approval** section shows each paused
publish with its reason (**Credential needs changed**) and the needs that
changed. **Approve and publish** needs `package:publish` and runs the real
publish (checks, fast-forward) for that exact commit, with the paused publish's
overwrite options; it also counts as the locked-publish approval. A later
publish replaces the pending request, and a request whose published base moved,
or whose pushed commit is no longer HEAD, can no longer be approved, so publish
again. A locked package keeps its locked-publish flow first: approving that
publish on approve-publish runs this check and pauses there if the needs
changed. Platform codemods do not pause.

## Approval when a package goes internet-visible

Turning on internet-visible serving in package settings, or with `packageUpdate`
(`internet_visible: true`), sends you to the same approval page. It lists what
the package and each of its dependencies declare or were given:

- credentials that fill a `kody.credentials` need: the org's credentials for
  that provider and kind (including members' personal credentials shared with
  the org), plus any credential mapped to that need in the package's credential
  settings
- credentials named in `kody.secretMounts`
- the package's own package-scoped credentials
- credentials you granted that package
- package storage, when the published source uses `packageStorage()` or a
  storage capability (or when the source cannot be read)

Account credentials a package could read only because you wrote it are not
listed; they are not a declaration. A package that declares nothing shows **This
package uses no credentials or other capabilities.**

One **Approve and make internet-visible** click approves that capability set and
turns internet-visible serving on. Each of the two decisions is still checked
and recorded in the org activity log on its own. If the capability set was
already approved, `packageUpdate` and the settings toggle turn internet-visible
on immediately without another Approve click.

When the published version has no [security audit](#security-audit) yet, both
responses also return the next step for the agent. `packageUpdate` returns
`security_audit` next to `approval_url`; the settings toggle returns
`securityAudit` next to `approvalUrl`. Each names the operation
(`packageSecurityAuditRecord`), its Open API route, and the exact `package_id`,
`published_commit`, and `fingerprint` to record. The agent runs the audit,
records it, and then hands you the approval link.

An agent can make a package internet-visible on its own (self-publish) when the
capability set the owner would approve is empty, the package and every package
it depends on declare nothing (no `kody.credentials` slots and no
`secretMounts`, `secretProvider`, `subscriptions`, `emits`, `jobs`,
`retrievers`, or `webhooks`), and a security audit with verdict `pass` is
recorded for the current published version. `packageUpdate` (and the settings
toggle) then turn serving on right away; `packageUpdate` returns
`self_published: true`. If the audit is missing, the request waits
(`self_publish_blocker: 'not_audited'`); recording a passing audit with
`packageSecurityAuditRecord` re-evaluates it and self-publishes then, and so
does calling `packageUpdate` again. The org activity log records it as
`package.went_public.self_publish`. A self-published package cannot use any
credential while it stays public this way, even one it declares later. To give
it credentials, declare them, publish, turn internet-visible off, and approve
turning it on again. Agents cannot self-approve a non-empty capability set. When
anything is declared or listed, `packageUpdate` returns the `approval_url` and a
`self_publish_blocker` that says why (`unpublished`, `stale_dependencies` (a
dependency republished since this package was published; publish it again),
`declares_credentials`, `declares_capabilities`, `not_audited`,
`audit_concerns`, or `not_permitted` when the caller cannot publish the
package).

## Approve many changes at once

When several approvals wait on you, an agent can put them on one page.
**`approvalPendingList`** (`GET /v1/approvals`) lists what waits on the
signed-in person and what they can decide:

- paused publishes (`publish`): credential needs changed, or the package goes
  public
- internet-visible packages whose credentials or storage changed since you
  approved them (`capabilities`)
- credential picks an agent proposed with `credentialMappingPropose`
  (`credential-picks`)

Each item says in plain words what approving grants: the credential, its kind,
provider, and hosts, plus what you approved before.

**`approvalBundleCreate`** (`POST /v1/approval-bundles`) takes item keys from
that list, or everything pending (narrowed by `types` and `packages`), plus an
optional note. It returns a URL, `/@{org}/-/approvals/{bundleId}`, which only
that person can open. The page groups items by package, with **Approve all** and
per-item **Approve** or **Deny**.

Approving an item runs that item's own approval, the same code as its package
page (**Approve and publish**, the capability approval, or the credential
approval). Approve all approves each item in turn and reports any that need
another look.

Denying a paused publish drops it, and the published version keeps serving.
Denying anything else changes nothing. The first decision on an item stands, and
every decision is recorded in the org activity log.

Agents only create bundles; approving is always the person's click in the
browser. Package code cannot create bundles. A bundle holds at most 100 items
and opens for 30 days. When a publish pauses and other paused publishes already
wait on the same person, `repoPublishSession`, `packagePublishExternalPush`, and
`packageSave` also return an **`approval_bundle_url`** (or name it in the
message) that approves them together.

## Security audit

The approval page has a **Security audit** field. It reads **No security audit
performed** until an audit is recorded for the package's current published
commit and capability fingerprint. Click it to copy a prompt for your agent. The
prompt names the package, commit, and fingerprint. It asks the agent to review
that version's code for declared vs used credentials, leaked credentials,
unintended public exposure, risky network hosts, and package storage use. An
agent that moves a package toward internet-visible gets the same request as the
`security_audit` next step (see
[Approval when a package goes internet-visible](#approval-when-a-package-goes-internet-visible)).

The agent records the result with **`packageSecurityAuditRecord`**
(`POST /v1/packages/{package_id}/security-audits`, `package:write` plus
`package:read`). It passes `package_id`, `published_commit`, `fingerprint`, a
`verdict` (`pass` or `concerns`), a plain-language `summary`, and an optional
`auditor` name:

```ts
await kody.packageSecurityAuditRecord({
	package_id: '…',
	published_commit: '…',
	fingerprint: '…',
	verdict: 'pass',
	summary: 'What was checked and found.',
})
```

The capability rejects a commit or fingerprint that no longer matches the
current version, and redacts token-shaped strings from the summary. Its response
includes `approval_url` and a `next_step` to send the owner that link. Each
record stores who recorded it and when, and is audit-logged. The field then
reads **Audited {date} by {auditor}** and links to the summary. A new publish or
a changed capability set reads as not audited again. The field covers only the
published version, not a paused publish waiting on the same page. Capability
items on an approval bundle page show the same state and link to the package's
approval page for the prompt or summary.

The audit is informational. It never approves capabilities or makes a package
internet-visible; Approve stays the owner's own click, except for self-publish
of a package that declares nothing.

## Community fork provenance

**`packageList`** and **`packageGet`** return community-fork provenance on each
package summary (`source_listing_id`, `listing_current`, `listing_name`,
`origin_commit`, `listing_pinned_commit`, `listing_published_at`,
`listing_ahead`). Those fields are `null` for self-authored packages.
`listing_ahead` is true only when the listing pin is not an ancestor of the fork
tip. When `listing_ahead` is true, the owner profile, the listing page, package
search, and `package:{package-name}` entity detail surface a **Fork outdated** /
absorb next step. Full workflow:
[Public packages → Forking a listing](./community-packages.md#forking-a-listing).

## Author a saved package via direct git push

Saved package source is backed by a Cloudflare Artifacts git repository. You can
create and edit it with a normal git client without round-tripping each file
change through `packageSave` or the file-level repo session capabilities
(`repoEditFiles`, etc.). This lane supports binary assets, which `packageSave`
and repo sessions do not.

Individual files may be at most 10 MiB (10,485,760 bytes), measured as the
file's stored byte length — UTF-8 bytes for text files, raw bytes for binary
assets. Publish checks reject any file over that per-file limit (and any source
root over the aggregate publish caps) with guidance to host the file on storage
you manage — for example Cloudflare R2, Amazon S3, Dropbox, or Google Drive —
and commit a small link or pointer file instead. Kody never rewrites your files
into pointers for you. The Artifacts remote itself also fails pushes above
roughly 32 MiB of pack content with a raw HTTP 413 before Kody is involved, so
oversized files can fail at `git push` with an unhelpful error even before
publish checks run.

1. Mint a short-lived remote credential:

   ```json
   {
   	"package_id": "pkg_123",
   	"scope": "write",
   	"ttl_seconds": 1800
   }
   ```

   Call `packageGetGitRemote` with the scoped `@owner/leaf` name for an existing
   package (or `package_id` when the name is not known). The result includes the
   plain remote URL, an authenticated one-line clone URL, an
   `Authorization: Bearer ...` extra header, `git_author` (the signed-in Kody
   account email and display name), and setup commands that use
   `git -c http.extraHeader=...` so the token does not need to be saved in shell
   history or `.git/config`. Those commands also set local `user.email` /
   `user.name` from `git_author`. Use that identity for commits; do not invent
   an email.

   To start a **new** package in this lane, pass `create: true` with `kody_id`
   set to the new `@owner/leaf` name (or the name leaf) and an optional
   `description` (at most 200 characters; a short public tagline):

   ```json
   {
   	"create": true,
   	"kody_id": "@you/new-package",
   	"description": "What this package is for"
   }
   ```

   Kody registers a private stub saved package (minimal `package.json`,
   `README.md` with an Intent placeholder, `AGENTS.md` with import/smoke-test
   placeholders, and a stub root export) and returns the minted remote in the
   same call. Replace the stub content in your first push.

2. Clone and edit:

   Run every `setup_commands` entry from the `packageGetGitRemote` result, in
   order, before creating commits. That sequence clones the repo, `cd`s into it,
   and sets local `user.email` / `user.name` from `git_author`. Then edit,
   commit, and push:

   ```bash
   git add .
   git commit -m "fix: update package behavior"
   git -c http.extraHeader='Authorization: Bearer art_v1_...' push origin HEAD:<defaultBranch>
   ```

   Use the default branch returned by `packageGetGitRemote` for
   `<defaultBranch>`.

3. Publish the pushed Artifacts HEAD:

   ```json
   {
   	"package_id": "pkg_123"
   }
   ```

   Call `packagePublishExternalPush`. Kody checks the pushed tree server-side
   before recording the new published version, writing the published source
   snapshot, rebuilding package bundle artifacts, and refreshing search
   projections. If the pushed HEAD is already current, the tool returns
   `already_published`. If the package is locked, it returns `locked` with a
   `pending_commit` and `approval_url` after checks pass and leaves
   `published_commit` unchanged. If it is internet-visible and its credential
   needs changed, it returns `approval_required` the same way (see
   [Approval when credential needs change](#approval-when-credential-needs-change)).
   If checks fail before promotion, it returns `checks_failed` with the failed
   check entries and leaves the underlying storage state unchanged. Full
   check-time esbuild is deferred to the later published artifact rebuild
   (callable and importable targets stay distinct). That rebuild copies
   unchanged callable, importable, app, job, and subscription artifacts from the
   previous published commit when the target's entry, reachable source, and
   bundler root config (`package.json`, wrangler config, vendored
   `node_modules`) match the new snapshot; a shared-module change dirties every
   dependent target. Stale captured `kody:@` dependency commits also force a
   rebuild, so republishing a stale dependent still refreshes inlined snapshots.
   Missing prior artifacts or snapshots, first publish, force, and
   `already_published` snapshot-mismatch repairs still rebuild. A published
   commit always has a complete target set — reuse writes the prior modules
   under the new commit key rather than leaving holes. A rebuild failure after
   promotion also returns `checks_failed` with a bundle check — re-run the
   publish capability to repair artifacts. Successful `published` responses, and
   `already_published` responses when the metadata is available, include a
   bounded `static_dependents` summary of direct saved packages whose published
   bundle artifacts statically reference this package. Stale entries mean the
   dependent bundle captured a dependency commit that differs from the current
   published commit. Kody does not automatically republish those dependents;
   inspect and republish only the ones whose static snapshot should reference
   the current published commit. Those same success results include
   `phase_timings` with optional millisecond fields `clone_ms`,
   `checks_typecheck_ms`, `checks_bundle_ms`, `rebuild_ms`, `dependents_ms`, and
   `total_ms`. Omitted keys did not run on that attempt. `checks_bundle_ms` is
   the publish bundle-check and is omitted when that esbuild pass is deferred to
   rebuild; `rebuild_ms` is the later artifact rebuild — they stay separate.
   Read `phase_timings` on the capability result; it is not available from
   `runList` or Cloudflare Log Explorer. When an interactive publish exceeds the
   inline budget (~35s), the tool returns `status: "dispatched"` with a
   `workflow_id` instead of hanging until the host times out. `dispatched`
   includes `phase_timings.total_ms` as time-to-dispatch. Poll `workflowRunList`
   with that `workflow_id` until the run finishes; do not retry the same publish
   while the run is active.

Computed `import(specifier)` (and other runtime package loads) resolve the
current published package at call time instead of embedding a source snapshot in
the dependent bundle. Those loads do not require republishing a dependent just
because the called package was republished. Static `kody:@` imports inside a
saved package still snapshot at that dependent's publish.

Choose the narrowest token scope that fits the task. Use `read` for inspection
or local diffing, and `write` only when the git client needs to push. Keep TTLs
short for autonomous agents and CI-style helpers; the tool accepts 60 seconds to
24 hours and defaults to 4 hours.

## Search and discovery

Search returns packages as the saved-entity unit.

Ranked package search hits may include a concise README excerpt when the saved
package has a root README so agents can learn usage, examples, and maintenance
notes without separately cloning the package repository.

Exact package detail includes nested exports, nested jobs, tags, app presence,
and README content when a root README exists. Search should not frame exports or
jobs as separate top-level saved entities.

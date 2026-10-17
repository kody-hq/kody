# Package codemods

Kody users own **saved packages**: source in Artifacts git repos, published
through repo checks into KV bundle artifacts. A **package codemod** is a
versioned, pure, deterministic, idempotent transform over a package's
**published file tree**. Codemods migrate user package source when the
platform's package API changes — the user-package analogue of D1 schema
migrations, applied fleet-wide with audit and revert support.

User-authored package contracts live in
[`packages-and-manifests.md`](./packages-and-manifests.md). Repo-backed source
and publish paths are covered in
[`architecture/data-storage.md`](./architecture/data-storage.md).

## What codemods are and are not

**Codemods are:**

- Transforms over the **published** source snapshot (the same tree
  `runRepoChecks` validates), not live Artifacts working copies.
- **Versioned in-repo** platform code, registered once, run many times across
  users and packages.
- **Pure** — `detect` and `transform` receive an in-memory file map and return
  findings or a new file map; no I/O, no ambient request context.
- **Deterministic and idempotent** — the same input tree always yields the same
  output; running `transform` twice on the result must not change files again.
- **Conservative** — when a pattern match is ambiguous, emit a `needsManual`
  finding instead of guessing.

**Codemods are not:**

- **D1 migrations.** Platform schema changes use SQL migrations under
  `packages/worker/migrations/`. Codemods change user-owned package source in
  Artifacts/KV, scoped per saved package and per user.
- **Repo-session edits.** Codemods do not patch arbitrary git working trees;
  they operate on the published snapshot the checks pipeline already built.
- **Community listing publishes.** A successful apply updates the owning user's
  saved package only. Pinned community listings keep serving the pinned commit;
  listing snapshots are not advanced by codemod apply or revert.
- **Personal codemods.** The built-in system is for **platform-authored**
  migrations: the transform ships in this repo, reviewed and fixture-tested in
  CI, because its correctness is pinned to a platform version and it runs
  fleet-wide over other users' source. A user transforming **their own**
  packages with **their own** transform needs no primitive — every required
  power (repo sessions, `repoRunChecks` against a staged tree, gated publish,
  git history) already exists as user capabilities. That userland pattern is
  packaged as the
  [`@kentcdodds/codemod-runner`](https://kody.codes/community/b06c0f98-865a-4379-adb0-d0fb2cdda14f)
  public package: same contract vocabulary (`detect`/`transform`,
  dry-run-before-apply, drift skips, idempotency verification, revert
  snapshots), with the codemod authored as a package export the user owns. As
  with any public package, inspect the source and fork (which pins your own
  copy) before running it against your packages. Do not grow the built-in engine
  to execute user-authored transforms; the dividing line is who authored the
  transform.

## Codemod contract

Each codemod lives at
`packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts` (for example
`0001-ambient-storage-to-package-storage.ts`) and is registered in
`packages/worker/src/package-codemods/registry.ts`.

Types in `packages/worker/src/package-codemods/types.ts`:

```ts
type PackageCodemodFinding = {
	path: string | null
	message: string
}

type PackageCodemodTransformResult = {
	files: Record<string, string>
	changed: boolean
	changedPaths: Array<string>
	needsManual: Array<PackageCodemodFinding>
}

type PackageCodemod = {
	id: string
	description: string
	/** Opt-in; default `head-and-published`. See Drift and applyMode. */
	applyMode?: 'head-and-published' | 'published-only'
	detect(files: Record<string, string>): Array<PackageCodemodFinding>
	transform(files: Record<string, string>): PackageCodemodTransformResult
}
```

- **`detect(files)`** — read-only scan. Returns `{ path, message }` findings
  without mutating the tree. Used for fleet discovery and reporting.
- **`transform(files)`** — returns a new tree plus metadata. When a hunk cannot
  be migrated confidently, leave the file unchanged and append a `needsManual`
  finding rather than applying a risky rewrite. **Partial transforms are
  intentional:** when `changed: true` and `needsManual` are both set, dry-run
  and apply still proceed with the partial tree (per-file conservatism with
  per-package progress). Findings are recorded on the ledger item and returned
  to the operator; the no-new-failures check gate still runs on that partial
  tree. A codemod that must be all-or-nothing should return the original tree
  with `changed: false` and only findings.

Implementations must stay **pure**: no `fetch`, D1, KV, secrets, or reads of the
calling user. The engine supplies the published file map; the codemod returns a
transformed map.

## Authoring guide

1. **Add the module** under
   `packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts`. Use the
   next sequential id; ids are stable compatibility contracts.
2. **Register** the export in `packages/worker/src/package-codemods/registry.ts`
   so the engine and operator surfaces can resolve it by id.
3. **Prefer mechanical rewrites** with clear before/after fixtures. Cover edge
   cases (already migrated imports, commented code, string literals that look
   like patterns but are not) with **fixture tests** beside the codemod
   (`*.node.test.ts` or `*.workers.test.ts`), using small in-memory file trees
   rather than full publish integration unless the behavior requires it.
4. **Emit `needsManual`** when:
   - multiple interpretations exist,
   - the pattern spans generated or minified output,
   - a required symbol cannot be resolved from static analysis alone, or
   - the codemod would delete user logic to satisfy the migration.
5. **Never put source contents in findings.** Finding `message` values must be
   fixed, codemod-authored strings; `path` identifies the file. Interpolating
   file contents, matched snippets, identifiers from user code, or manifest
   values into a finding would surface private package source to the operator
   running the fleet scan, breaking the
   [privacy policy's codemod disclosure](../use/privacy.md#platform-maintenance-package-codemods)
   ("codemods are forbidden from embedding file contents in their findings").
   Shipped codemods use constant messages; keep it that way.

### `0001-ambient-storage-to-package-storage`

This permanent repair codemod converts ambient `storage` imports rejected by
package publish checks to `packageStorage()` **at call sites**:

- Rewrites member uses (`storage.get(...)` → `packageStorage().get(...)`) via
  AST range replacement; it does **not** insert a module-scope
  `const storage = packageStorage()` binding.
- Adjusts the `kody:runtime` import: rename `storage` → `packageStorage`, or
  drop the `storage` specifier when `packageStorage` is already imported.
- Emits `needsManual` for aliased imports, non-member uses (value-passing),
  re-exports, multiple runtime imports, binding sites, and post-rewrite
  verification failures.
- Emits `needsManual` for **parse failures** on scannable module files that
  mention `kody:runtime` and `storage`.
- **Manifest gate:** when `package.json#kody` declares any non-empty `app`,
  `jobs`, `subscriptions`, `webhooks`, or `retrievers` surface, every
  ambient-storage candidate file gets `needsManual` — ambient `storage` and
  `packageStorage()` use different bucket identities on those execution
  surfaces, so automatic rewrite risks silent data repointing.

### `0002-static-first-invocation`

This permanent repair codemod brings package source into the static-first
two-rule contract enforced at publish time (see
[`architecture/invocation-overhead-guardrails.md`](./architecture/invocation-overhead-guardrails.md)):

- Rewrites `packages.invokeChecked(...)` member calls (including
  `packages?.invokeChecked`) to `packages.invoke(...)` via AST range
  replacement, then composes the `0006-invoke-object-to-specifier` repair over
  those files so safe object inputs become scoped string-first calls in the same
  run.
- Emits `needsManual` when that second-stage object repair cannot safely derive
  the owner/target. That second stage is all-or-nothing: any manual finding
  restores the original tree and returns `changed: false`, forcing the engine's
  `needs_manual` stop instead of applying a partial rewrite to removed API.
- Emits `needsManual` for `packages.check(...)` (its contract return value has
  no mechanical equivalent — `invoke` checks internally) and for literal dynamic
  `import("kody:@...")` (namespace semantics and `kody.dependencies` manifest
  changes need a human), naming the replacement in each finding.
- Emits `needsManual` for parse failures on scannable module files that
  reference unsupported forms, and verifies post-rewrite that no detectable
  `packages.invokeChecked` member expressions remain.
- Detection reuses the publish-check collector
  (`package-runtime/deprecated-invocation-usage.ts`), so parsed `detect`
  findings and failing publish lint results stay in lockstep. Unparseable files
  produce codemod-only `needsManual` findings because publish lint cannot
  classify them.

### `0003-heykody-domains-to-kody-codes`

This origin-migration codemod rewrites published package references from the
legacy web origins to the canonical app origin:

- Rewrites `https://heykody.app` and `https://heykody.dev` (hostname-boundary
  safe, including a sentence-final period) to `https://kody.codes`.
- Does **not** rewrite subdomains (`status.heykody.dev`, `inbox.heykody.app`),
  lookalike hosts, emails, or `LEGACY_*` configuration values.
- Emits `needsManual` for every remaining `heykody.app` / `heykody.dev` mention
  after the origin rewrite (bare hostnames, emails, nested labels).

### `0004-kodyapps-dev-to-kody-run`

This origin-migration codemod rewrites published package references from the
legacy package-app origin to the canonical hosted-app origin:

- Rewrites `https://kodyapps.dev` and `https://{user}.kodyapps.dev` (one DNS
  label, hostname-boundary safe) to `https://kody.run` /
  `https://{user}.kody.run`.
- Does **not** rewrite `kody.codes`, `heykody.app`, `heykody.dev`, inbox hosts,
  MCP paths, `status.heykody.dev`, nested labels (`https://a.b.kodyapps.dev`),
  lookalike hosts, or `PACKAGE_APP_LEGACY_*` configuration values.
- Emits `needsManual` for every remaining `kodyapps.dev` mention after the
  origin rewrite (bare hostnames, nested labels, lookalikes).

### `0005-kody-dependencies-to-wildcard-map`

This one-shot manifest-format codemod rewrote `package.json#kody.dependencies`
from the legacy array of scoped names to a name-to-`*` map. New publishes reject
arrays; the codemod remains for any leftover published trees:

- Rewrites `["@scope/pkg"]` to `{ "@scope/pkg": "*" }`, including an empty array
  to `{}`.
- Rewrites the agent-common `latest` alias to `*`. Already-migrated `*` maps are
  left unchanged.
- Emits `needsManual` for unsupported versions (semver ranges, commit SHAs),
  unscoped names, and missing or invalid `package.json`.
- Does **not** change resolution: `*` is latest-at-publish, captured when the
  dependent republishes. It is not a live pin.

### `0006-invoke-object-to-specifier`

This permanent repair codemod converts the publish-blocked object-only dynamic
package API to an explicit owner-scoped specifier:

- Rewrites
  `packages.invoke({ kodyId: "target", exportName, params, idempotencyKey, topic })`
  to
  `packages.invoke("kody:@owner/target", { exportName, params, idempotencyKey, topic })`.
  The owner scope comes from the invoking package's `package.json.name`, which
  preserves the old API's caller-owned lookup.
- Handles direct and optional `packages?.invoke` calls and preserves option
  expressions and keyless/exactly-once behavior.
- Rewrites complete examples in JavaScript/TypeScript Markdown fences and inline
  code spans. Untyped/unsupported fences, partial snippets, and matching prose
  remain unchanged with `needsManual`.
- Leaves already string-first calls unchanged and is idempotent.
- Emits `needsManual` for immutable `packageId` targets, dynamic or indirect
  input objects, calls without `exportName`, computed properties, spreads,
  comments in the removed field, parse failures, and manifests without a valid
  scoped package name.
- Emits file-level `needsManual` findings when the `package.json` scope is not
  the package's org: the old bare-id lookup resolved in the package's org, so
  rewriting to a different manifest scope would retarget the call.
- Remains registered because publish checks permanently reject object-only
  `packages.invoke` in JavaScript and TypeScript. Authors and operators can use
  this codemod as the mechanical repair path for source that predates or
  bypasses those checks.

### `0007-prefix-packages-invoke-specifiers`

This permanent migration codemod moves string-first dynamic invocation to the
preferred explicit scheme:

- Rewrites literal `packages.invoke("@owner/package[/export]", options)` calls
  to `packages.invoke("kody:@owner/package[/export]", options)`.
- Rewrites parseable non-object dynamic first arguments (identifiers, member and
  helper-call expressions, conditionals, and interpolated templates) through a
  marked inline normalizer. The original expression is passed into the IIFE and
  therefore evaluated exactly once. At runtime the normalizer trims strings only
  to detect a leading `@`, prefixes that trimmed prefixless value, and passes
  already-prefixed strings, other strings, and non-strings through unchanged so
  the existing runtime parser still canonicalizes or rejects them.
- Preserves the complete options argument byte-for-byte, including `exportName`,
  so an export subpath keeps its existing precedence.
- Handles JavaScript and TypeScript modules plus parseable JS/TS fenced and
  inline examples in Markdown and MDX. TypeScript uses a return assertion on the
  generated normalizer; JavaScript and untyped inline examples use a JSDoc
  expression assertion, so generated JavaScript contains no TypeScript syntax.
- Leaves already-prefixed calls and marked generated normalizers unchanged and
  is deterministic and idempotent.
- Emits fixed, privacy-safe `needsManual` messages for ambiguous bindings,
  spread/missing arguments, genuinely call-shaped examples outside parseable
  JS/TS Markdown ranges, and parse failures. Unparseable source has no textual
  rewrite fallback: without an AST, the codemod cannot prove either binding or
  argument boundaries safely. Markdown prose that merely names `packages.invoke`
  without a following call is ignored. Messages never interpolate a specifier,
  package, export, parameter, or source value.
- Leaves object-only calls unchanged. Their migration remains the permanent
  `0006-invoke-object-to-specifier` codemod's responsibility.

Prefixless calls remain publishable during this measurement phase; 0007 is a
migration aid, not a publish-rejection rule.

### `0008-packages-invoke-to-static-import`

This permanent migration codemod removes author-facing `packages.invoke`
(decision 0037):

- Rewrites literal `packages.invoke("kody:@owner/package/export", { params })`
  calls to a static `import export from "kody:@owner/package/export"` plus
  `export(params)`, and adds the package name to
  `package.json#kody.dependencies` when the rewrite is in a JS/TS module. Repo
  checks only count those static imports, so Markdown examples are rewritten
  without declaring unused dependencies.
- Rewrites computed first arguments to `(await import(specifier)).default(...)`.
  That is the name-as-data path; do not use this rewrite when the name is known
  at write time.
- Handles JavaScript and TypeScript modules plus parseable JS/TS fenced and
  inline examples in Markdown and MDX.
- Emits `needsManual` for keyed invokes (`idempotencyKey` — use workflows),
  ambiguous options, and leftover prose that still names `packages.invoke`.
- Leaves already-migrated static imports unchanged and is idempotent.

Fleet scan `803e3045` found zero executable-source findings, drift, or errors.
Its three remaining findings are private README-only documentation debt: those
files cannot execute and therefore do not block later runtime/type prefix
removal once the telemetry gate passes. Keep the debt tracked as an aggregate
owner-action count without publishing private package ids or owners. Codemod
0007 and the local prefixless teaching error remain the repair path for those
documents.

### `0009-snake-case-kody-members`

This one-shot cleanup recases leftover snake_case builtin `kody` members to
camelCase JavaScript identifiers:

- Rewrites `kody.package_get(...)` and `kody["package_get"](...)` to
  `kody.packageGet(...)` in JavaScript and TypeScript modules, including
  leftover ambient `kody` calls that never imported `kody:runtime`.
- Rewrites `capability:package_get` entity refs in those modules and in Markdown
  / MDX.
- Leaves `kody.mcp["server"].tool_name(...)` unchanged. MCP-synthesized tools
  keep their upstream names.
- Emits `needsManual` for computed `kody[id]` where the property is data, and
  for files that mention a snake_case member but cannot be parsed.

Builtin capability and domain ids are camelCase identifiers (`emailSend`,
`mcpServers`). Input field names, usage-metric event types, Codex TOML
`[mcp_servers.kody]`, and SQL `cf_agents_mcp_servers` stay snake_case.

### `0010-detect-legacy-credential-patterns`

This detect-only codemod lists credential placeholder patterns in package source
and the root `package.json` (see
[Credential slots](../use/packages.md#credential-slots-kodycredentials)).
`transform` writes nothing; dry-run and apply return the findings as
`needs_manual`. Run it with `adminPackageCodemodScan`.

It scans JavaScript and TypeScript modules and the root `package.json`. Each
finding message starts with one fixed pattern label:

| Label                  | Matches                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `literal secret`       | A complete `{{secret:…}}`, `{{secret-basic:…}}`, `{{secret/provider:…}}`, or `{{integration-token:…}}` placeholder, or a known string passed to `createAuthenticatedFetch`, `packageSecrets.get`, `secretHeaders.basic`, or similar helpers, unless it names a declared slot of its kind |
| `computed secret`      | A secret placeholder built at runtime, or a secret helper called with a runtime name                                                                                                                                                                                                     |
| `computed integration` | `createAuthenticatedFetch`, `integrationTokenRefresh`, or `{{integration-token:…}}` with a runtime name                                                                                                                                                                                  |
| `kody.mcp`             | Any `kody.mcp` access, including `const { mcp } = kody`                                                                                                                                                                                                                                  |
| `\|scope=`             | A `\|scope=` placeholder suffix with a literal or computed scope, or a `scope` option on a secret helper                                                                                                                                                                                 |
| `secretMounts`         | `package.json#kody.secretMounts`. Detected, and a manifest-only declaration is a non-failing compat finding: keep mounts stale static dependents still read (`static_dependents`) and delete a mount only once none do. `packageSecrets.get` in new source still fails the publish gate. |
| `webhook secretName`   | `verification.secretName` or `challenge.prove.secretName` on a `kody.webhooks` entry                                                                                                                                                                                                     |
| `plain http`           | A `fetch` or `new Request` of an `http://` URL in a module that uses placeholders                                                                                                                                                                                                        |
| `packageSecrets.get`   | Any `packageSecrets.get` or `kody.packageSecretGet` call                                                                                                                                                                                                                                 |

A reference that names a declared `kody.credentials` slot of its kind is not a
finding. A secret name needs a `secret` slot: `{{secret:NAME}}`, either
`{{secret-basic:…}}` name, `packageSecrets.get`, and the secret helper fields.
An integration name needs an `oauth` slot: `{{integration-token:NAME}}`,
`createAuthenticatedFetch`, and `integrationTokenRefresh`. A vault reference
names no slot, so it stays a finding.

A known string is a literal, a top-level `const` string (including one imported
from a relative module), or a template or `+` chain of those. A local binding
that shadows a module constant is not treated as that constant.
Placeholder-shaped text that names nothing, such as `{{secret:<name>}}` in help
or redaction text, is ignored. Test files (`*.test.*`, `*.spec.*`, and anything
under `__tests__/`) are skipped unless a runtime entry points at them: `exports`
(import/default, not types-only), `main` / `module` / `browser`, `kody.app`
entries, job entries, subscription handlers, or a module those entries reach
through a bundler-resolved import (`import` / `export … from`, `import()`,
`require()`).

Helpers are matched by name, comments are ignored, and an unparseable module
falls back to a text match. An unsuffixed `{{secret:NAME}}` still reads a
package-scoped secret before the user one, and no static scan can see that, so
`|scope=` findings undercount package-scoped buckets. Count those from secret
rows with `scope = 'package'`. Publish seals literal credential uses into a
credential stamp (issue #3836 phase 1) and **fails the build** on non-literal or
unstampable patterns. This module yields a publish gate failure for `index.ts`
(computed integration/secret names and `|scope=`; `kody.mcp` is reported by this
codemod but does not fail publish in phase 1):

```ts
import { createAuthenticatedFetch, kody } from 'kody:runtime'

export default async function digest(input: { account: string; key: string }) {
	const google = await createAuthenticatedFetch(input.account)
	await kody.mcp.linear.list_issues({})
	return fetch('https://api.example.com', {
		headers: {
			'x-api-key': `{{secret:${input.key}}}`,
			authorization: 'Bearer {{secret:EXAMPLE_TOKEN|scope=package}}',
		},
	}).then(() => google('https://www.googleapis.com/calendar/v3/users/me'))
}
```

Publish error (credentials check `ok: false`): the package must be
**conversion-ready**. Declare every credential as a fixed `kody.credentials`
slot with a real description, call only literal keys (`credential("SLOT")` /
`createAuthenticatedFetch("SLOT")` / `{{secret:SLOT}}`), and remove `|scope=`,
`packageSecrets.get`, vault placeholders, server `eval` / `new Function` /
non-literal `import()`, and computed names. A manifest that still declares
`kody.secretMounts`, with no `packageSecrets.get` in the new source, does not
fail the gate: the check stays `ok: true` and notes the aliases kept for stale
static dependents. Removing a mount or deleting its secret breaks those
dependents; publish warnings name them. Callers pick which saved credential
fills each slot with the execute `credentials` call map
(`{ "SLOT": "credential-name" }` or CLI `--credential SLOT=name`) or a
stored/trigger mapping — never choose the credential name at runtime inside
package code. Literal `kody.mcp.SERVER` names are stamped as `kind: "mcp"` slots
(phase 2); dynamic `kody.mcp[variable]` fails the stamp gate. The `kody.mcp`
0010 label remains for migration tracking. `credential.named()` stays limited to
ad hoc runs and unshared personal-org packages (not stamped).

Save each scan step result as its own JSON file, then print the report over all
of them:

```bash
node tools/credential-pattern-report.ts .tmp/scan/
```

It takes any number of files or directories. A directory reads its `.json` files
in natural order (`step-2.json` before `step-10.json`). When a package appears
more than once, the last item read wins.

It counts packages and files per pattern, per org, and per package, plus
`skipped_unpublished` and `skipped_drift`. The org and package tables name
private packages. Keep them out of public issues; public issues get the pattern
counts only.

### `0011-owner-scope-follows-registry`

This codemod runs after an [org resource transfer](./org-resource-transfer.md).
The transfer moves each package to the new org, but package sources still name
the old scope. The engine builds `context.packageName` from the owning org's
package scope and the package leaf, not from `saved_packages.name` (that column
mirrors the published `package.json`, so a revert or projection refresh puts the
old scope back). When the scope of the `package.json` `name` differs from the
owner scope, the codemod replaces every `@<oldScope>/` with `@<newScope>/` in
every file. That covers the manifest name, `kody.dependencies` keys,
`kody:@oldScope/...` imports, and docs.

- A match must be followed by `/`, so `@oldScopeish/x`, a bare `@oldScope`
  handle, and email addresses are left alone. It shares
  `rewriteScopedReferences` with the community fork self-reference rewrite.
- Every package in the old scope moved together, so references to sibling
  packages are rewritten too.
- Packages whose scope already matches, unscoped names, and unparseable or
  missing manifests are clean. The codemod is idempotent.

Once the transfer has committed, run `adminPackageCodemodDryRun`, then
`adminPackageCodemodApply`, with `userIds` set to the new org id.
`adminPackageCodemodRevert` undoes it like any other codemod. A revert puts the
old scope back in the sources, so the next scan detects the package again.
Reverting a package whose `kody:@oldScope/...` dependencies no longer exist
under the old scope fails the publish checks and leaves the package applied.
Re-applying after a revert can report `dry_run_new_failures` for a package whose
sibling dependency is still registered under the old scope. Run apply again once
the sibling is applied.

### `0012-explicit-webhook-url-secret-verification`

Detect-only. Lists `package.json#kody.webhooks` entries that declare no
`verification`. Omitting `verification` is a supported, permanent state: ingress
treats it as `url-secret` and publish accepts it (see
[Senders that cannot sign](../use/webhooks.md#senders-that-cannot-sign-url-secret)).
Findings are a recommendation for owners to declare a type, not a migration.

- `transform` never changes files, so dry-run and apply report `needs_manual`
  with the same finding and never republish a package.
- Packages without `kody.webhooks`, or whose webhooks all declare
  `verification`, are clean.
- Emits a manual-review finding for missing or invalid `package.json`, a
  `kody.webhooks` that is not an array of objects, and a `verification` that is
  not an object.
- An earlier version rewrote manifests to add
  `"verification": { "type": "url-secret" }` (same behavior at ingress) through
  the published-only lane. It keeps `applyMode: 'published-only'` so
  `adminPackageCodemodRevert` of those runs takes the same lane.

### `0013-declare-credential-needs`

Prepares for credential-need enforcement
([#3822](https://github.com/kody-hq/kody/issues/3822)). That enforcement limits
a package that someone other than its author runs to the credentials it
declares. The codemod adds a `kody.credentials` slot for each name the package
fills through the fetch gateway by a literal name and does not declare yet:
`{{secret:NAME}}`, `{{integration-token:NAME}}`,
`createAuthenticatedFetch('NAME')`, and the secret fields of
`secretHeaders.basic` and `oauthClientCredentials`. Names are resolved through
module and imported constants, as in `0010`. A name that `kody.secretMounts`
also mounts still gets a slot, because the stored needs closure reads only
`kody.credentials`.

Each new slot has no `kind` and a fixed description the owner can reword.
Placeholders resolve by name whatever their slot says, so this changes nothing
at run time. Helpers that resolve outside the gateway (`packageSecrets`,
`secretJwtSign`, `integrationTokenRefresh`) get no slot.

`credential('key')` / `credentials('key')` keys (aliased imports and
`kody.credential(...)` included) get no slot. A slot's kind decides what
`credential()` can resolve (a slot with no kind takes only secret, oauth, or
login credentials), and the source cannot say which kind a key takes.

The codemod adds no slot and reports `needs_manual` for an undeclared
`credential()` key, a computed name or key, a vault ref, a name that is not a
valid slot key, a declared slot whose kind cannot fill the use, and `credential`
passed around instead of called. A package whose `package.json` does not parse
is reported too. For a nested package it reads the manifest at the entity
source's `manifest_path` and only the files under its `source_root`. It uses
`applyMode: 'published-only'`, so drifted and locked packages are updated
without moving default-branch HEAD. Publishing stores the new needs closure with
the approval pause skipped, as for every codemod.

Run it with `filters.scope: 'credential-need-enforcement'`. A rescan with the
same filter must come back clean before the enforcement flag is turned on.

### `0014-seal-credential-stamps`

Fleet seal for [issue #3836](https://github.com/kody-hq/kody/issues/3836)
phase 2. Declares missing `kody.credentials` slots for every stampable literal
use (`credential("KEY")`, placeholders, `createAuthenticatedFetch`, JWT signing
names, and literal `kody.mcp.SERVER` names) and fills an inferred description
when the slot has none. Existing descriptions are never overwritten. Literal MCP
servers get `kind: "mcp"`; OAuth / integration names get `kind: "oauth"`;
signing names get `kind: "signing"`.

Packages with unstampable patterns (non-literal names, `|scope=`,
`packageSecrets.get`, `credential.named`, server eval, dynamic `kody.mcp`) stay
`needs_manual`. Manifest-only `kody.secretMounts` may stay for stale static
dependents and does not block sealing. Prefer `0015-convert-credential-stamps` /
`adminCredentialStampMigrate` for behavior-preserving conversion before leaving
packages on the publish gate. It uses `applyMode: 'published-only'`.

After apply (or for packages that were already seal-ready), run
`adminCredentialStampBackfill` to restamp seal-ready packages that still lack a
KV stamp at the current `published_commit`. A package with a stored stamp is
limited at runtime to its declared credential slots, including a stamp the fleet
still calls `would_restamp` (keys or dependency pins drifted). Packages this
scan reports as `needs_manifest`, `unconvertible`, `deferred_scan_budget`, or
`failed` have no stamp and keep the legacy credential path until a republish
stores one. `missingStampPackages` counts only `would_restamp` rows. It does not
include `unconvertiblePackages`, `needsManifestPackages`,
`deferredScanBudgetPackages`, or `failedPackages`. The legacy path can be
removed when one full dry-run (`nextCursor` null) reports every one of those
counters, plus `missingStampPackages`, as zero. Only `stamped` and
`skipped_unpublished` remain.

### `0015-convert-credential-stamps`

Platform migration for
[issue #3836](https://github.com/kody-hq/kody/issues/3836): convert other
owners' published packages (including `@kody/*`) when the result is
stamp-sealable without disruption. Operator surface:
`adminCredentialStampMigrate` (audited admin mutation; dry-run default).

Safe transforms only:

- Declare allowlisted missing bare npm deps the tree already imports, including
  side-effect imports (today: `remix@3.0.0`).
- Seal inferred `kody.credentials` descriptions (same plan as `0014`).

Does **not** strip `|scope=package` (or any `|scope=`): unsuffixed secret lookup
prefers session before package, so removing the suffix would widen resolution.
Those packages stay on the publish gate. Package-bound Keys can fill that same
package's declared needs (exact name match or sole candidate), which lets owners
convert off `|scope=package` placeholders onto needs without new secrets; this
codemod still does not rewrite those placeholders itself.

Skips without writing when:

- The package is a Kent holdout (`@kentcdodds/raycast`,
  `@kentcdodds/oauth-integration-health`).
- Blocking stamp-gate failures remain (computed names, any `|scope=`,
  `packageSecrets.get`, vault placeholders, `server_eval`, `credential.named`,
  …). Manifest-only `kody.secretMounts` does not block.

Never emails or notifies owners, never creates credential values, and relies on
the existing republish path so job/trigger enablements stay as they are. Uses
`applyMode: 'published-only'`. After apply pages finish, run
`adminCredentialStampBackfill` to write KV stamps. Leftover cleanup is tracked
in the linked #3836 cleanup issue.

## Engine

The engine entry point is `runPackageCodemodStep` in
`packages/worker/src/package-codemods/engine.ts`. Long runs are **paged**: each
call processes up to `limit` packages (or revert items) and returns `nextCursor`
plus a per-step `summary` count by item status. Continue with the same `runId`
and `nextCursor` until `nextCursor` is null.

The admin UI walks those pages as separate HTTP requests. MCP `execute` and
inline workflow sandboxes do not: dry-run, apply, and revert are check-heavy
enough that a second page in the same sandbox typically exceeds the workflow
observer (5-minute sandbox budget, under the Cloudflare Workflow step timeout).
Those modes take one page per execute or workflow sandbox. When `nextCursor` is
set, start a new `execute` or `workflows.create` with that `runId` and cursor.
Omitted filters inherit from the stored run. Capability results include a
`nextStep` string that restates this. Scan pages are cheaper and can often
continue in the same sandbox.

### Step limits

| Mode                         | Default `limit` | Max `limit` |
| ---------------------------- | --------------- | ----------- |
| `scan`                       | 20              | 50          |
| `dry-run`, `apply`, `revert` | 5               | 10          |

Fleet scan mode may scan up to five D1 pages of 50 saved packages per step while
applying filters, and can return a progress `nextCursor` even when the current
step matched zero packages.

### Modes

| Mode      | Behavior                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`    | Run `detect` only; record findings per package.                                                                                                                                                                                                                                                                                   |
| `dry-run` | Run `transform` in memory, then run the full publish check suite (`runRepoChecks`) on **both** the original and transformed trees. Pass only when transformed checks introduce **no new failures** compared to the original. Also verifies mechanical idempotency by transforming twice and requiring an unchanged second result. |
| `apply`   | Same gates as dry-run. On success: snapshot the original published tree to KV for revert, commit and push (see [Drift and applyMode](#drift-and-applymode)), refresh the saved-package projection, and dispatch subscription events (see below). Re-checks drift immediately before the write.                                    |
| `revert`  | For each `applied` item on a prior apply run: load the KV revert snapshot, verify the publish tip is still safe to restore (HEAD match for `head-and-published`; published-commit match for `published-only`), write the snapshot tree back, mark the source apply item `reverted`, and dispatch `package.codemod.reverted`.      |

Locked packages (`saved_packages.locked_at` set) still run apply and revert for
`head-and-published` codemods when HEAD matches published: the engine commits
and pushes HEAD and does **not** advance `published_commit`. The owner reviews
that HEAD commit later at `/@username/:name/approve-publish?commit=…`.
`published-only` codemods **always finalize** `published_commit`, including on
locked packages via `allowLockedPublish`. If that creates a sibling of pending
HEAD, approve-publish promotes that commit: the owner click passes `allowForce`
with destructive overwrite confirmation (backup required).

Per-package failures are **isolated**; one package error does not abort sibling
items in the same run step.

### Run lifecycle

Runs are created as `running` and end `completed` only when a caller pages until
`nextCursor` is null. The other transitions keep the ledger honest when paging
stops early:

- **Heartbeat** — every step re-asserts `running` and bumps the run's
  `updated_at`, so `updated_at` doubles as a liveness signal. Continuing a
  `failed` or `abandoned` run reopens it.
- **`failed`** — written when a step throws at the run level (paging, ledger
  writes); per-item failures never fail the run.
- **`abandoned`** — written when the admin UI stops a run (stop button, step
  ceiling, stuck cursor) via `POST /admin/codemods/run/stop.json`, or by lazy
  reconciliation: loading the admin history marks `running` runs whose heartbeat
  is older than one hour. There is no scheduled sweeper; abandoned callers
  (closed tabs, agents that stopped paging) are caught on the next history load.

Abandoned and failed **apply** runs can still hold `applied` items; revert
accepts them (the admin UI only blocks revert while a run is `running`).

### Drift and applyMode

By default (`applyMode: 'head-and-published'`, or omitted), apply requires
Artifacts default-branch HEAD to equal `published_commit`, then writes through
`syncArtifactSourceSnapshot` so HEAD and published stay aligned. Drifted
packages are `skipped_drift`.

Codemods that set `applyMode: 'published-only'` (today: `0012`, `0013`, `0014`,
`0015`) change only the **drifted** lane:

1. Load the published tree (same as today).
2. Run the same transform + check gates.
3. Commit the transformed files as a **child of** `published_commit`.
4. Push that commit to the durable non-default ref `refs/heads/kody-published`
   (never the default-branch tip — owner unpublished work on HEAD is untouched).
5. Call `finalizePublishedEntitySource` to write KV then advance
   `published_commit`.

When HEAD already matches published, published-only codemods still use
`syncArtifactSourceSnapshot` so HEAD and published stay aligned.
`syncPublishedSourceSnapshotOnly` requires `expectedPublishedCommit` and refuses
when `published_commit` moved (concurrent owner publish). On a non-fast-forward
`kody-published` push it re-reads `published_commit`: still equal → force-push
(recover leftover tips after a push that never finalized); moved → refuse.
Revert chooses the lane from tip state: if HEAD still equals the apply
`afterCommit`, restore via `syncArtifactSourceSnapshot`; otherwise restore via
published-only (no HEAD match required; default-branch tip is not moved).

### Safety rails

- **`skipped_unpublished`** — packages with no published commit are skipped.
- **`skipped_drift`** — when Artifacts default-branch HEAD does not match
  `entity_sources.published_commit`, the engine skips and never overwrites
  **unless** the codemod opts into `applyMode: 'published-only'` (see
  [Drift and applyMode](#drift-and-applymode)). Apply re-checks drift after
  transform gates pass and before KV snapshot / publish. Revert for
  `head-and-published` compares HEAD to the prior apply item's
  **`afterCommit`**; `published-only` revert compares `published_commit` instead
  and never moves default-branch HEAD.
- **Apply snapshots** — before publish, apply writes the pre-codemod published
  tree to `BUNDLE_ARTIFACTS_KV` at `package-codemod-revert:{userId}:{itemId}`
  with a **90-day TTL** and stores that key on the ledger item as
  `revert_snapshot_key`.
- **Check gate** — apply and dry-run both require the transformed tree to pass
  `runRepoChecks` without regressions versus the original tree.

### Item statuses

Each per-package row in a run records one of:

`detected`, `clean`, `dry_run_ok`, `dry_run_new_failures`, `needs_manual`,
`skipped_drift`, `skipped_unpublished`, `applied`, `reverted`, `failed`.

## Ledger

Every run and per-package item is stored in D1 (tables defined in
`packages/worker/migrations/0001-squashed-init.sql`). Pagination cursors live on
step responses, not in the ledger tables.

**`package_codemod_runs`:** `id`, `codemod_id`, `mode`, `scope_user_id` (`NULL`
for fleet runs), `initiated_by_user_id`, `filters_json`, `status` (`running` |
`completed` | `failed` | `abandoned`), `revert_of_run_id`, `created_at`,
`updated_at`.

**`package_codemod_run_items`:** `id`, `run_id`, `user_id`, `package_id`,
`kody_id`, `status`, `before_commit`, `after_commit`, `changed_paths_json`,
`findings_json`, `check_summary_json`, `error`, `revert_snapshot_key`,
`created_at`, `updated_at`.

Ledger writes **bound** large text columns (`error`, `check_summary_json`,
`findings_json`, `changed_paths_json`) to restorable UTF-8 byte limits; findings
cap at 50 entries and changed paths at 200, with truncation notices when
overflowing.

The ledger makes runs **resumable** (page forward with `nextCursor`),
**auditable**, and **revertible** (revert reads KV snapshots keyed by
`revert_snapshot_key`). Revert is only possible while the KV snapshot remains
(90-day TTL). All rows are scoped by the owning user's saved package identity;
cross-user reads are a bug.

## Operator surfaces

### Admin UI

`/admin/codemods` supports fleet **scan**, **dry-run**, **apply**, and
**revert** for a selected codemod. Filters include `userIds`, `packageIds`, and
`limit` so operators can canary a subset before a full fleet apply.

### User-owned packages

Users transforming **their own** packages use the
[`@kentcdodds/codemod-runner`](https://kody.codes/community/b06c0f98-865a-4379-adb0-d0fb2cdda14f)
public package (same `detect`/`transform` contract, dry-run-before-apply, and
revert snapshots). The built-in engine stays reserved for platform-authored
fleet transforms; see
[What codemods are and are not](#what-codemods-are-and-are-not).

### MCP — fleet (`admin` domain)

Admin-gated operator fleet runs:

- `adminPackageCodemodScan`
- `adminPackageCodemodDryRun`
- `adminPackageCodemodApply`
- `adminPackageCodemodRevert`
- `adminPackageCodemodOwnerNotice` (see [Owner notice](#owner-notice))

Their `filters` take `userIds`, `packageIds`, and `scope`. Setting
`scope: 'credential-need-enforcement'` keeps a run to packages someone other
than their author may run (see
[`0013-declare-credential-needs`](#0013-declare-credential-needs)). Reverts
ignore `scope`; they only touch items an earlier run applied.

Admin capabilities require `requiredRole: 'admin'` and follow the RBAC boundary
in [Authorization](./architecture/authorization.md).

## Rollout doctrine

Platform package API changes that break existing user source follow this
sequence (formalizing existing practice):

1. **Land the platform change** with deprecation shims and warnings so old
   patterns still publish.
2. **Fleet scan** — run codemod `detect` across packages; review findings and
   `needs_manual` volume.
3. **Fleet dry-run** — review diffs and dry-run reports; fix codemod gaps before
   apply.
4. **Canary apply** — use admin filters (`userIds` / `packageIds`) for a small
   cohort; monitor checks, projections, and subscriber notifiers.
5. **Fleet apply** — page through the full population.
6. **Owner notice** — before a gateway, credential, or other runtime rule starts
   refusing what affected packages still do, email each affected owner what
   breaks, when, and how to fix it. See [Owner notice](#owner-notice). Required
   whenever a scan finds packages a codemod cannot fix (for example
   `needs_manual` findings).
7. **Land enforcement** — add or tighten publish-time lint/checks so **new**
   publishes cannot use the deprecated pattern, and turn on the runtime rule.

Skipping dry-run or canary apply risks mass check failures; skipping step 6
breaks packages with no warning; skipping step 7 allows new packages to
reintroduce debt. After enforcement lands, drop the deprecation shims when no
remaining packages need them — or open a GitHub issue if that drop must wait.
See [Cleanup after migrations](./cleanup-after-migrations.md).

### Owner notice

`adminPackageCodemodOwnerNotice` emails the owners of every package a scan run
flagged. Run a fresh scan after fleet apply, so owners whose packages the
codemod already fixed are not warned, and pass that scan's `runId`. Dry-run,
apply, and revert runs are refused, and a scan still running can be previewed
but not sent. Also pass a stable `noticeId` (for example
`2026-10-body-placeholders`), a `subject`, `whatBreaks`, `howToFix`,
`effectiveAt` (when the rule takes effect, in words), and optionally
`findingMessages` (exact finding messages to include; omit for every finding in
the run).

- **Dry run by default.** `dryRun` defaults to `true`. It lists each owner with
  their flagged packages and a status, and renders a preview of the first email.
  Review the preview before sending with `dryRun: false`.
- **Recipients.** Every `owner` of the owning org with a verified email. A
  personal org with no membership rows goes to the user whose id is the org id.
  Owners with no verified address report `no_recipients`.
- **Once per notice and recipient.** A KV claim
  (`package-owner-notice:v1:<noticeId>:<ownerId>:<userId>`, 180 days) is written
  after each successful send. A re-run skips delivered recipients
  (`already_sent` once all are reached) and retries the rest (`send_failed`
  until then). `claim_failed` means the email went out but its claim did not
  save, so a re-run may send it again. KV has no atomic claim, so run one notice
  from one place at a time.
- **Content.** The email names up to 25 affected packages with a link to each
  and its findings, then the fix. Never put secret values, internal hostnames,
  or other owners' data in `whatBreaks` or `howToFix`.
- **Paging.** Owners are processed in id order, `limit` (default 20, max 50) per
  call. Pass `nextCursor` back until it is `null`. A scan with more than 10,000
  items is refused; filter the scan first.

## Revert

Apply persists the pre-codemod published tree to KV (`revert_snapshot_key`,
90-day TTL) before republishing the transformed tree. **Revert** mode creates a
new run with `revert_of_run_id` pointing at the prior apply run, pages through
source items with status `applied`, loads each KV snapshot, and republishes with
commit message `revert codemod(<id>)` — via `syncArtifactSourceSnapshot` for
`head-and-published`, or `syncPublishedSourceSnapshotOnly` for `published-only`.
On success it marks the **source apply item** `reverted`, refreshes projections,
and dispatches `package.codemod.reverted`.

For `head-and-published`, revert requires default-branch HEAD to still equal the
source item's `afterCommit`. For `published-only`, revert requires
`published_commit` to still equal `afterCommit` (or, for locked non-promoted
applies, still equal `beforeCommit`) and does not move HEAD. Missing or expired
KV snapshots fail the revert item. Revert does not restore Artifacts
working-copy edits made after apply.

Runs are single-pass in every mode: items that fail or are drift-skipped are
recorded on the run but not retried within it. Because failed or skipped source
items keep their `applied` status, retrying is starting a **new** revert run
against the same apply run — it picks up exactly the items that were not
reverted.

Steps do not take a per-package lock. Publishes serialize in the repo session
Durable Object and transforms are deterministic, so overlapping steps of the
**same** codemod are benign, but do not fleet-apply two **different** codemods
concurrently — the second may transform stale published source.

## Subscription events

After each successful **apply** or **revert**, the host dispatches
`package.codemod.applied` or `package.codemod.reverted` to packages saved by the
**owning user** that declare the topic — the same delivery pattern as
`run.error.recorded`. Payload shape and handler guidance live in
[Package subscriptions](../guides/package-subscriptions.md).

## Related

- [Packages and manifests](./packages-and-manifests.md)
- [Adding capabilities](./adding-capabilities.md) — MCP capability registration
- [Package subscriptions](../guides/package-subscriptions.md) — event payloads
- [Data storage](./architecture/data-storage.md) — published source and KV

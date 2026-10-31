# 0089: Every package declares its capabilities; publish checks the import closure

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Since the
[0068 amendment of 2026-10-24](./0068-credentials-own-placement-scoped-clients.md#amendment-2026-10-24-package-apps-run-as-their-publisher),
a package app runs as its publisher, and only Kody capabilities listed in
`kody.app.capabilities` run that way. That list has to cover the capabilities of
every package the app imports, but only apps can declare anything, and nothing
checks the list at publish. Undeclared calls are caught only at runtime, as hard
rejections (counted in `package_app_authority_rejections`), so a mistake reaches
users before the author hears about it. Codemod
`0018-declare-package-app-capabilities` is the one-time cleanup of saved
manifests (Phase 1). This record covers how the gap stays closed afterwards.

## Decision

Capability needs are checked at publish, from declarations. The runtime does not
discover them.

- **Every package declares.** Any package (app or not) lists the Kody
  capabilities its own modules call in `kody.capabilities`. An app's own list
  stays in `kody.app.capabilities`, which is read as that package's declaration.
  There is no second list for apps to keep in sync. MCP server tools are listed
  by exact name, `mcp:<server>:<tool>` (the name `kody.mcp[server][tool]` calls
  and `callCapabilityAs` checks); there is no per-server wildcard, so a tool a
  server adds later needs its own declaration.
- **Effective requirement.** At publish, an app's effective capabilities are its
  own declaration plus the declarations of every package in its static import
  closure (`kody:@scope/name` imports, followed through each export the app
  reaches). The runtime caps the app's calls as the publisher to that set, so
  importing a package brings that package's declared needs with it.
- **Statically verified calls.** Publish and `kody dev check` run the same
  `runRepoChecks`. They check every `kody.<name>(...)` call in a package's
  modules against that package's declaration. A call whose name can't be
  verified statically (a computed member, or `kody.mcp`) fails the check unless
  a capability already declared covers it. An undeclared literal name fails the
  check.
- **Runtime is a backstop.** `callCapabilityAs` keeps refusing undeclared calls.
  A hard rejection (counter above zero) is a bug in the check or the closure
  computation, not an author mistake, and is fixed in the platform.
- **Rollout.** The check ships warn-only: publish and `kody dev check` report
  findings but don't block. It switches to fail only after Kent has applied
  Phase 1 in production. The switch is a separate follow-up.
- **Phase 3 cleanup.** The #4278 visitor fallback path in `runWithAuthority`,
  `ownerCredentialForVisitors`, the fallback table, and its report are deleted.
  After Phase 1 is applied and the hard-rejection count stays at zero for about
  14 days, delete the rejection table and log, and the Phase 1 migration code
  (codemod 0018, its migration report, the codemod host-facts lane, and its
  rejection/allowance gap filling). The import-closure scanner stays: the
  publish check uses it, so it moves next to the publish checks instead of being
  deleted.

## Consequences

- Authors of library packages declare what their code calls. Apps that import
  them stop guessing their dependencies' needs.
- The closure walk at publish costs one saved-package read per imported package.
  It reuses the 0018 closure scanner and 0017's call extraction, so there is one
  scanner.
- Dynamic call names need a declaration an author can see. The check never
  passes a name it can't prove.
- Revisit if the warn-only findings show a large class of legitimate dynamic
  calls that no declaration can cover, or if the closure walk makes publish
  measurably slower.

## Amendment 2026-10-31: per-version allowances

Retiring the package-app visitor retry would break a few published app versions
that call capabilities they never declared. Instead of loosening the cap,
`package_app_capability_allowances` records, per app and published commit, the
exact capability names the fallback telemetry saw that version call (seeded once
by migration 0226). The runtime treats those names as declared for that commit
only. A new publish gets no allowance; the package page, publish, and
`kody dev check` name what to add to `kody.app.capabilities` before that
publish. `__kodyIntegrationRuntimeConfig` (behind `createAuthenticatedFetch`) is
an internal host helper, not a capability, and never needs a declaration.

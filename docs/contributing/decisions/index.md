# Decision records

A **steering veto list**. Open the list below before proposing a new primitive,
surface, or storage home. Architecture docs and code describe how the system
works today; this folder records product-shaped decisions **already made**,
usually a no with a revisit-if.

Linked from the [contributor map](../index.md) (and the short
[AGENTS.md](../../../AGENTS.md) window into it) for that check — not as homework
and not as a museum.

A good record is half a page: context, the decision, consequences. See
[0025](./0025-no-package-services-primitive.md) for the shape that actually
steers (write the no before the next agent re-proposes the primitive).

Decision records are point-in-time documents, so they are exempt from the
temporal-language member of `npm run docs:check`; everything else in `docs/`
describes current behavior (see
[documentation principles](../documentation.md)).

## When to add a record

Write one after you have already decided **not** to build something the next
agent will otherwise re-propose. Copy [`0000-template.md`](./0000-template.md)
to the next unused number (read this index on `main` first) with a kebab-case
slug. Keep it to roughly half a page.

Do **not** write an ADR on every PR. Number collisions (two 0022s, then two
0028s, then two 0029s the same day) are the failure mode of that habit. If a
number collides, renumber the later record; do not leave duplicates. The
decision-record member of `npm run docs:check` (part of `npm run validate`)
rejects duplicate primary numbers. A lab note may share a number only as
`NNNN-*-lab.md`.

Do **not** record layout or UI tweaks, mode assignments, or "we use library X"
unless that pick is a no that will otherwise be re-litigated.

When a later record changes a decision, mark the old one `superseded by NNNN`
rather than editing or deleting it, and list it under
[Historical / UI / implementation](#historical--ui--implementation).

Add new steering records to the steering list, not a catch-all numbered dump.

## Steering list

Open these before proposing a new primitive, surface, or storage home.

- [0001 — No user-facing package versioning or import pins](./0001-no-package-versioning.md)
- [0031 — `kody.dependencies` is a name-to-`*` map; still no pins or live resolution](./0031-kody-dependencies-wildcard-map.md)
- [0002 — Data placement: D1, per-user Durable Objects, Analytics Engine](./0002-data-placement.md)
- [0003 — Repos are the base primitive; packages are an explicit extension](./0003-repos-as-base-primitive.md)
- [0004 — Status page stays a separate worker with its own storage](./0004-status-page-separate-worker.md)
- [0005 — Keep the MCP legacy lane until metrics retire it; no Tasks yet](./0005-mcp-dual-lane-stateless-migration.md)
- [0006 — No repo/package CI primitive](./0006-no-repo-ci-primitive.md)
- [0007 — Keep in-house feature flags; no package flag primitive](./0007-keep-in-house-feature-flags.md)
- [0008 — No traces, previews, browser-run, gradual deploys, or session mining](./0008-declined-adlc-primitives.md)
- [0011 — Keep workers-unit per-file isolation; do not warm DOs to "fix" slowness](./0011-workers-unit-pool-harness.md)
- [0013 — Post-publish checks stay on MCP; no signed app URLs or inbox injection](./0013-synthetic-package-requests.md)
- [0037 — No author-facing `packages.invoke`](./0037-no-author-packages-invoke.md)
  — static import, `import(specifier)`, or workflows; external HTTP is
  [0048](./0048-webhooks-replace-invocation-tokens.md)
- [0048 — Inbound HTTP is webhooks; invocation tokens drain](./0048-webhooks-replace-invocation-tokens.md)
  — no `*` webhook URLs; HTTP invocation tokens fully removed (`0084` purged
  rows; `0085` dropped `package_invocation_tokens`)
- [0017 — Hosted package apps use per-user subdomains; same-owner isolation deferred](./0017-per-user-package-app-subdomains.md)
- [0020 — Repo sessions spill Workspace objects to R2; do not adopt `@cloudflare/computer`](./0020-repo-session-workspace-r2-not-computer.md)
- [0021 — Publish-gated packages; no in-process composition runtime](./0021-publish-gated-package-composition.md)
  (credential authority for scoped clients superseded in part by 0068)
- [0022 — Retire the values primitive; do not add a thinner settings twin](./0022-retire-values-primitive.md)
- [0023 — Progressive search disclosure; no full-SDK dumps or unbounded listings](./0023-progressive-search-disclosure.md)
- [0024 — Packages outrank synthesized providers; no auto-delete or ranking toggle](./0024-packages-outrank-synthesized-providers.md)
- [0025 — No package services primitive](./0025-no-package-services-primitive.md)
- [0032 — No unattached jobs; schedules belong to packages or workflows](./0032-no-unattached-jobs.md)
- [0033 — No user-as-conversation, MCP session, or user-global memory hide](./0033-no-user-as-conversation.md)
  ([lab](./0033-memory-auto-surface-lab.md); lab script removed, source in git
  history at `51def919d`)
- [0034 — Origin owns no Durable Object classes](./0034-origin-owns-no-durable-objects.md)
  — platform classes live on `kody-platform`; do not put them on origin,
  runtime, or jobs, and do not add a second origin-facing content worker
- [0041 — No hardcoded operator correspondence when an admin topic exists](./0041-no-hardcoded-operator-correspondence.md)
  — platform owns the fact and the event; packages own the reaction; no official
  `@kody/*` admin-notify package
- [0042 — No capability-input secret placeholders or capability allowlists](./0042-no-capability-input-secrets.md)
  — fetch host approval and package grants remain; do not re-add `x-kody-secret`
  input resolution or a per-secret capability allowlist
- [0043 — Repo visibility is the share switch; no community-package kind](./0043-repo-visibility-no-community-kind.md)
  — no `package.json#private` SoT, no second publish semantics
  (`communityPublish` stays a visibility alias), no license bureau, no trusted
  listings
- [0044 — Retired brand domains stay retired](./0044-retired-brand-domains-stay-retired.md)
  — do not re-attach `heykody.app`, `heykody.dev`, or `kodyapps.dev` as app,
  package-app, status, or email hosts
- [0045 — Official guides load through search, not execute](./0045-guides-load-through-search.md)
  — `guide:{id}` entity detail is the read path; do not execute `codingGuideGet`
  just to load a guide
- [0046 — Community is the catalog; public is the visibility word](./0046-community-is-the-catalog.md)
  — no “community package” kind-name; do not rename `/community` or the MCP
  `community` domain; listing_* identifiers stay until a dual-declare cut
- [0047 — One Vectorize index with per-user namespaces until 5,000 users](./0047-vectorize-per-user-namespaces-until-5k-users.md)
  — no sharding or metadata-only filtering before 5k accounts; the shard shape
  is pre-decided for when it is needed
- [0049 — No MCP capability OAuth scopes](./0049-no-mcp-capability-oauth-scopes.md)
  — connecting an agent is one grant; `openid` / `profile` / `email` stay
  identity claims, not a permission menu
- [0051 — Pro bills include → credits → stop](./0051-include-credits-stop.md) —
  at $0, usage past the include stops and the full Pro include stays; never a
  Free-limits fallback; no customer-facing fund-to-unlock rates and no free
  past-include burn; 50× is a credits ceiling, not a tier
- [0052 — OAuth refresh expectation comes from the token response](./0052-oauth-refresh-policy-from-token-response.md)
  — no app/adapter refresh defaults and no blanket `missing_refresh_token`
  Waiting suppression; wait only when the connect response implied refresh
- [0053 — Scoped API tokens are a separate credential class, not MCP OAuth scopes](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md)
  — `kody_at_` tokens authenticate the Open API and CapabilityProxy; MCP OAuth
  stays one full grant; amended by 0055 for CLI login on local-execute HTTP, by
  0056 for explicit session→CLI bootstrap codes, and by Teams P4 so token scopes
  are org permissions
- [0054 — No vendor-specific platform logic](./0054-no-vendor-specific-platform-logic.md)
  — capabilities stay generic; third parties configure via params/presets, not
  `foo-hub`-style type forks in platform schema or handlers
- [0055 — CLI MCP OAuth may authenticate local-execute HTTP only](./0055-cli-mcp-oauth-local-execute-http.md)
  — `kody login` Bearer on CapabilityProxy + package-graph (full MCP grant);
  other Open API routes stay `kody_at_`-only; amended by 0056 for headless/agent
  bootstrap without a second interactive OAuth, and by 0076 so login OAuth may
  also mint a device `kody_at_` on `POST /v1/tokens/device`
- [0056 — Explicit MCP/API session → CLI credential bootstrap](./0056-cli-credential-bootstrap.md)
  (amended 2026-10-06: required lifetimes, 500-token cap, reclaim by soonest
  expiry; 2026-10-09 Teams P4 + 0092: default scopes restore `local-execute`
  parity including `integration:read` / `secret:use`) — one-shot `kody_bc_…`
  code from `cliCredentialBootstrap` (capability + Open API); CLI redeems for
  `kody_at_…` without chat-facing secrets or host-token scavenging
- [0057 — No framework platform affordance for package bundles](./0057-no-framework-platform-affordance.md)
  — do not vendor, mount, inject, sniff, or rewrite package bundles for Remix,
  TanStack, Preact, or any other framework; packages bring frameworks themselves
- [0058 — Skills over MCP ship as a flagged progressive enhancement](./0058-skills-over-mcp-progressive-enhancement.md)
  — `mcp-skills-extension` (default off, `experiments_opt_in`), modern lane
  only; packages stay the source of truth at `skills/<name>/SKILL.md`; no
  `kody.skills` manifest key; tools stay search/execute/api; supersedes 0015
- [0059 — MCP Events extension (webhook profile) behind a flag](./0059-mcp-events-extension-behind-flag.md)
  — `kody.emits` topics with `mcp: true` reach ChatGPT-style webhook subscribers
  through the existing package events consumer; flag plus client capability
  gate; Workers-limited SSRF guard documented
- [0060 — Owner ids and person ids are separate types; storage stays keyed as-is](./0060-owner-and-person-ids.md)
  — `OwnerId` (owning org) vs `PersonId` (actor), `personalOrgId` is the only
  conversion; no `orgs` tables, column renames, or storage re-keying yet
- [0061 — One request context for every request source](./0061-one-request-context.md)
  — every caller context names its `RequestSource`; `RequestContext` (org,
  actor, attribution, credential, membership) is derived, never persisted;
  Automation has no actor; downstream runs inherit lineage
- [0062 — One org access check, declared by every surface](./0062-one-access-check.md)
  — `authorize` is the one org check; every capability declares `orgPermission`
  and every Open API operation publishes `x-kody-permission`; site admin stays
  separate. Teams P4 removed the leftover `x-kody-scope` check
- [0063 — Teams P3 expand adds org rows without moving storage keys](./0063-teams-expand-orgs.md)
  — `orgs` / `org_memberships` / `handles` land; personal orgs reuse
  `users.stable_user_id` as `orgs.id` so storage keys do not move; entitlements
  dual-write; soft-delete columns are additive
- [0064 — OAuth consent binds a grant to one org](./0064-oauth-org-binding.md) —
  stamp `orgId` on grant props and metadata; `?org=` plus consent picker (no
  flag; one org = no picker); connection profiles stay org-bound narrowing, not
  OAuth scopes; `userId` fallback for grants without `orgId`
- [0065 — Org seats and prepaid credits](./0065-org-seats-and-prepaid-credits.md)
  — org-billed seats and credits; usage past the include follows 0051 (an empty
  wallet keeps the full Pro include and never drops to Free limits); Stripe
  writes stay Kody-only
- [0066 — Teams soft delete, restore window, and purge lane](./0066-soft-delete-and-purge.md)
  — 30-day restore window, live `deleted_at IS NULL` reads plus scanner, purge
  lane with `deleting_at`, org vs user deletion split, purge audit in
  `org_audit_events`, first purge dry-run, no feature flag
- [0067 — Cross-org grants replace package shares and platform accounts](./0067-cross-org-grants-replace-shares-and-platform-accounts.md)
  — shares are `use` grants, scope grants are Owner memberships, platform
  accounts are ordinary orgs; a package imports only its own org's packages and
  cross-org access is a grant or a fork (supersedes 0014, 0035, 0036, 0050)
- [0068: Credentials own placement; scoped clients replace slots and assignments](./0068-credentials-own-placement-scoped-clients.md)
  is the source of truth for the credentials model. Today's secrets are the Key
  type and keep filling placeholders permanently; by-name grants stay; nothing
  is scheduled for removal. Opt-in types (scoped `credential()` clients with
  credential-owned hosts and placement, `url`, `login`, `signing`) use the
  actor's Use plus `package:execute` as the only authority. No assignment tables
  or saved bindings; the fleet codemod is an owner-approved suggestion
  (supersedes scoped-client credential authority in 0021 and credentials plan v4
  sections 3.3 and 3.4)
- [0069 — Internet-visible apps pin an approved capability snapshot](./0069-internet-visible-capability-pinning.md)
  — accepted 2026-10-12 amendment to 0001. Narrow exception for internet-visible
  serving and approved-bundle retention only; no semver or import pin syntax.
  Forks do not inherit the origin's approval
- [0070 — User-owned API tokens and persistent git HTTPS auth](./0070-user-owned-api-tokens-and-git-credentials.md)
  — CLI bootstrap defaults to person-owned tokens (`?org=` per request);
  `tokenCreate` defaults to org-bound; `kody auth setup-git` stores long-lived
  `kody_at_…` for clone/fetch/push of `kody.codes/@owner/name.git`
- [0071 — Custom domains for package apps (Cloudflare for SaaS on kody.run)](./0071-package-app-custom-domains.md)
  — SaaS custom hostnames on the package-app zone; org-level for private apps,
  per-app for internet-visible (not merely forkable); CNAME/ALIAS only (no
  Enterprise apex A/wildcards); org admins; one free domain then $0.10/mo;
  verify before serve; 24–48h DNS grace then remove
- [0072 — Memory is personal-only](./0072-memory-is-personal-only.md) — one
  writable pool per person (personal org); tools always use personal regardless
  of connection org; shared org knowledge is packages + org instructions;
  team-org rows are write-frozen legacy until cleanup

- [0074 — One email address per org; admins see all mail, packages only through per-sender enablements](./0074-org-email-address-and-per-sender-enablement.md)
  — `{slug}@inbox.kody.codes`; Mailbox keyed by org id; per-sender enablement
  rows; inbox-owner fallback retired; migrated personal catch-alls tagged
  `any_authenticated`
- [0075 — Repo pushes serialize through a per-repo Durable Object in a dedicated worker](./0075-repo-push-queue-worker.md)
  — `kody-push-queue` owns `RepoPushQueueV1`; pack lands before enqueue; FIFO
  one push at a time; 90s budget then 503 `Retry-After: 2`; no fallback; gated
  by the repo-scoped `repo-push-queue` flag
- [0076 — CLI login mints a device API token](./0076-cli-login-device-token.md)
  — `POST /v1/tokens/device` exchanges official CLI OAuth for a user-owned
  `kody_at_…`; `POST /v1/execute` is that token with `org:execute`; MCP and
  local-execute OAuth stay for older CLIs
- [0077 — OAuth device authorization grant (RFC 8628)](./0077-oauth-device-authorization-grant.md)
  — one server backend (`device_start` / `device_poll`), two entry points
  (`/connect/oauth` + MCP); `device_code` and client secret stay server-side;
  additive `device_authorization_url` + `flow=device`

## Historical / UI / implementation

Accepted or superseded records that do **not** change the next product proposal.
Do not treat this list as homework. History stays; it is not silently deleted.

- [0073 — Community listing pin follows promote](./0073-community-listing-follows-promote.md)
  — active listings auto-follow `published_commit`; no separate Update public
  listing step; Settings **Publishing** panel is the owner surface
- [0015 — Wait on Skills over MCP; serve skill content via packages](./0015-skills-over-mcp-wait.md)
  — superseded by 0058; Skills over MCP now ship behind a flag
- [0050 — Package share grants are not platform scope grants](./0050-package-share-grants-are-not-scope-grants.md)
  — superseded by 0067; shares are `use` grants and scope grantees are Owners
- [0036 — Person accounts do not run official platform packages](./0036-platform-packages-fork-only.md)
  — superseded by 0067; platform accounts are ordinary orgs and cross-org
  imports are refused
- [0035 — Platform packages are execute-only; person packages must fork](./0035-platform-packages-execute-only.md)
  — superseded by 0036, then 0067
- [0014 — Platform scopes resolve live; person-account imports stay caller-owned](./0014-platform-live-packages.md)
  — superseded by 0035, 0036, then 0067
- [0009 — Shiki for in-app syntax highlighting](./0009-shiki-syntax-highlighting.md)
  — library pick; the highlighter is already in the app
- [0010 — One RecordTable for account and admin list/detail screens](./0010-account-record-table.md)
  — superseded by 0028; UI diary (working notes are not steering)
- [0012 — Client-safe shared code lives in `#universal/*`](./0012-universal-layer.md)
  — encoded by [import boundaries](../import-boundaries.md) and lint
- [0016 — Extract the package runtime and jobs lanes into separate workers](./0016-mono-worker-extraction.md)
  — landed; see the architecture runbooks
- [0018 — Inbound CLA for external contributions to this repository](./0018-inbound-cla.md)
  — legal/process; see [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [0019 — Self-hosted Nx remote cache (not Nx Cloud)](./0019-self-hosted-nx-remote-cache.md)
  — contributor infra, not a product primitive
- [0038 — Still no Nx Cloud; split self-hosted cache read and write tokens](./0038-no-nx-cloud-read-write-cache-tokens.md)
  — token split; who may write is 0040
- [0039 — Same-repo pull_request jobs do not write the Nx cache](./0039-no-same-repo-pr-cache-writes.md)
  — superseded by 0040
- [0040 — Same-repo writers may PUT the Nx cache; fork PRs may not](./0040-same-repo-writers-may-put-nx-cache.md)
  — push access already implies the local write token
- [0026 — Invocation tokens belong to one package; no account-level wildcard bearer](./0026-package-owned-invocation-tokens.md)
  — superseded by 0048; HTTP tokens fully removed
- [0027 — No invocation-token source allowlist](./0027-no-invocation-token-source-allowlist.md)
  — superseded by 0048; HTTP tokens fully removed
- [0028 — List/detail records expand inside the table](./0028-list-detail-expand.md)
  — UI mode assignment (supersedes 0010)
- [0029 — Discord social login and official guild role](./0029-discord-social-login-and-guild-role.md)
  — superseded by 0030; invite-only membership is no longer the product path
- [0030 — Join the official Discord during social login](./0030-discord-guilds-join-on-social-login.md)
  — `guilds.join` on Discord social login; token still discarded after the
  callback

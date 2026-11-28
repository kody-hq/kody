# Frozen storage contracts

[Data storage overview](./index.md)

## Frozen storage contract inventory

This section records identifiers and serialized shapes that should be treated as
permanent unless a planned migration explicitly says otherwise. They are cheap
to document and expensive to discover after user data depends on them.

### D1 JSON shadow schemas

The following columns store JSON whose schema is defined in TypeScript rather
than in D1 constraints. Changes must be backward compatible on read and additive
on write unless a migration backfills existing rows.

- `jobs.params_json`, `jobs.schedule_json`, `jobs.caller_context_json`, and
  `jobs.repo_check_policy_json`
  (`packages/jobs-worker/migrations/0001-jobs-init.sql`,
  `packages/shared/src/jobs/repo.ts`) rely on parser and normalizer
  compatibility. Package jobs persist both `storageContext.appId` for value
  scope and `storageContext.packageId` for package-owned secret scope.
- `saved_packages.tags_json` and `community_listings.tags_json`
  (`packages/worker/migrations/0001-squashed-init.sql`) are `string[]`
  projections. `community_listings.category`
  (`0022-community-listing-category.sql`) is a closed browse category
  (`integrations`, `examples`, `productivity`, `apps`, `utilities`, or `other`).
  Publish copies `package.json#kody.category` when it is an author category.
  Missing or `other` falls back to well-known tag inference (examples, then
  integrations, productivity, apps) and otherwise stores `other`. The same
  inference backfills existing `other` rows in
  `0022-community-listing-category.sql`. Reads use the stored column so browse
  filters and chip counts stay aligned.
- `published_bundle_artifacts.dependencies_json` (`0001-squashed-init.sql`)
  stores package dependency pointers queried with SQLite JSON functions in
  `packages/worker/src/repo/published-bundle-artifacts-repo.ts`.
- Keyed invocation replay lives in the RunLog Durable Object ledger (see
  [Run records](../run-records.md)). D1 has no `package_invocations` or
  `package_invocation_tokens` table.
- `webhook_endpoints` (`0001-squashed-init.sql`,
  `0057-webhook-url-secret-encrypted.sql`,
  `0062-webhook-url-rotation-grace.sql`,
  `0072-webhook-hmac-secret-encrypted.sql`,
  `0127-webhook-hmac-rotation-grace.sql`) stores per-user minted URL state for
  `package.json#kody.webhooks`, keyed by `(user_id, package_id, webhook_name)`.
  Webhook on/off state lives only in `enablements` (the legacy `enabled` column
  was dropped in `0242`). URL secrets are SHA-256 hashed for ingress and AES-GCM
  encrypted (`url_secret_encrypted`) for server-side apply. Package-owned HMAC
  signing material lives on the same row (`hmac_secret_encrypted`) when
  verification omits `secretName`; provider-issued secrets use the secrets
  primitive via optional `verification.secretName`. Last-seen signing identity
  (`hmac_secret_name`) and a verification snapshot
  (`hmac_verification_secret_encrypted`) track declared-secret rotation;
  `previous_hmac_secret_*` holds the outgoing key for a 24h grace window (same
  duration as URL rotate overlap). MCP capabilities never return the plaintext
  URL or HMAC. Delivery history is recorded as `webhook` surface run records
  (see [Run records](../run-records.md) and [Inbound webhooks](../webhooks.md)),
  not as D1 rows.
- `system_email_daily_counters` (`0001-squashed-init.sql`) stores fixed
  per-local daily receive counters for operator-owned system inboxes. These
  counters are not user entitlements and are pruned by the system-email
  retention job.
- `mcp_memories.tags_json` and `mcp_memories.source_uris_json`
  (`0001-squashed-init.sql`) back memory search and provenance.
- `secret_entries.expires_at` (`0023-secret-entry-expires-at.sql`) is the
  optional per-secret UTC expiry the account UI and `secretSet` write. Session
  lifetime stays on `secret_buckets.expires_at`. Resolve and fetch placeholders
  treat an expired entry as missing; list and account views still show the row
  so it can be rotated. Effective remaining TTL is the earlier of entry and
  bucket expiry.
- `secret_entries.allowed_hosts` and `secret_entries.allowed_packages` are JSON
  string lists used as security policy inputs (`0001-squashed-init.sql`,
  `0032-drop-secret-allowed-capabilities.sql`). Tightening parse-error behavior
  requires explicit compatibility review. `allowed_packages` applies only to
  user-scoped secrets. Unadopted community-forked packages need it for every
  package read/use path (provenance via `community_forks.forked_package_id` +
  `forker_user_id`; index in `0001-squashed-init.sql`). Self-authored packages
  and adopted forks (`community_forks.adopted_at` / `adoption_note`) skip that
  grant for read/use only. Mutations from package code (`secretSet` /
  `secretDelete`) always require the grant. Only the account owner can add a
  package to that grant (secret editor or `/@<slug>/-/secrets/approve`).
  `resourceLock({ kind: 'secret', name, package_id })` returns an approval URL
  and does not change `allowed_packages`. Removing a grant is website-only.
- `secret_provider_bindings` and `secret_provider_grants`
  (`0064-secret-provider-bindings.sql`) pin one saved package plus door-key
  secret name to a provider id per account, and grant saved packages use of a
  canonical `(provider, ref)`. Declaring `kody.secretProvider` is not a binding.
  Owners revoke grants on `/@<slug>/-/secret-providers`. Unbind, and rebind to a
  different provider package, drop grants (`ON DELETE CASCADE` from the
  binding). See [secret providers](../../secret-providers.md). Official OAuth
  token rotation persists host-side and does not use that write grant.
  Authorship and adoption never imply a host allowlist. Package-scoped secrets
  are owned exclusively by the package id in their bucket binding.
- `user_oauth_apps.extra_authorize_params_json`,
  `user_integrations.scopes_json`, `user_integrations.required_hosts_json`, and
  `user_integrations.allowed_packages_json` (`0001-squashed-init.sql` /
  `0026-integration-owned-credentials.sql`, `packages/worker/src/integrations/`)
  store a string→string object, a scope string list, a host string list, and a
  saved-package-id list respectively. Parsers in the integrations data-access
  layer own the shapes. Access and refresh token ciphertexts live on
  `user_integrations`; the user-lane client secret ciphertext lives on
  `user_oauth_apps`. Those columns are the only credential store — there are no
  `*_secret_name` pointers and the values are not in `secret_entries`. Account
  export redacts the ciphertext columns.
- `provider`, `inject_json`, and `source_json` on `secret_entries`,
  `user_integrations`, `mcp_server_settings`, and `secret_provider_bindings`
  (`0111-credential-provider-inject-source.sql`) are the credential fields from
  [ADR 0068](../../decisions/0068-credentials-own-placement-scoped-clients.md).
  `inject_json` is a header, basic, or query rule and defaults to
  `Authorization: Bearer {value}`. `source_json` is `"stored"`, or
  `{"vault": "<provider>"}` on a vault binding. An integration's `provider` is
  its OAuth app's provider, written on connect and backfilled by the migration.
  Request placement does not read them; placeholders still decide it.
- `secret_entries.kind` (`0117-credential-kinds.sql`) is the credential's kind
  from ADR 0068: `secret` (every existing row and the default), `url`, `login`,
  or `signing`. Placeholders fill only `secret` rows. A `url` value is a whole
  HTTPS URL that `resolveCredential` hands to the gateway only for one of the
  row's `allowed_hosts`; package code sends a relative path, never the URL.
- `secret_entries.config_json` (`0118-credential-login-config.sql`) is a `login`
  credential's exchange: an HTTPS URL on one of the row's `allowed_hosts`, the
  body template, and where the session token is in the response. Other kinds
  leave it NULL. The value holds the login fields as one JSON object, and
  `inject_json` places the session token. Kody keeps the session in
  `login_credential_sessions`, never in `secret_entries`.
- `login_credential_sessions` (`0206-login-credential-sessions.sql`,
  `packages/worker/src/credentials/login-session-store.ts`) holds one row per
  `login` credential: the session token its exchange returned, encrypted with
  the `login-credential-session` purpose and bound (AAD) to the owner,
  credential id, and revision, plus `expires_at`. The revision is a digest of
  the credential's ciphertext, `config_json`, `allowed_hosts`, and
  `inject_json`, so an edit to any of them strands the session; deleting the
  credential deletes the row. `lease_id` / `lease_expires_at` are a 60-second D1
  lease so one exchange runs at a time per credential across isolates.
  `failure_revision`, `failure_kind`, `failure_count`, and `retry_after`
  (`0216-login-credential-session-failures.sql`) record the last failed exchange
  for one revision: callers fail fast until `retry_after` (backoff from 30
  seconds to 15 minutes), `needs_reconnect` (the provider answered
  `invalid_grant`) holds until a new revision, and `rejected` backs off the 401
  retry after a fresh session was refused. A success clears an exchange failure;
  a new revision ignores the old one. The session is never code-readable and
  never in capability output, logs, errors, or audit details. Account and org
  deletion delete rows by `user_id` (the owning org); account export omits the
  table.
- `credential_inventory_runs` and `credential_inventory_items`
  (`0112-credential-inventory.sql`,
  `packages/worker/src/credentials/credential-inventory.ts`) hold the admin
  fleet inventory of credential placeholders in published package source.
  `adminCredentialInventoryScan` pages saved packages into a run; each item's
  `result_json` holds credential ids, placement shapes, slot providers, and
  placeholder counts (every placeholder, including ones that match a declared
  slot), never a credential name or value. Placement shapes may carry package
  identifiers (a body field, an SDK option key, a callee name) but never one
  that spells a credential name. A failed item holds only its load error, and
  the report lists failed package ids. `adminCredentialBackfill` reads a
  complete run with no failed packages (or whose failed packages the caller
  lists exactly in `acknowledgedFailedPackageIds`) and writes `provider` and
  `inject_json` only where they are still unset: `provider` when every slot
  naming the credential agrees on one provider slug, `inject_json` when every
  placement is the same header or the same query param.
- `credential_org_grants` (`0116-credential-org-grants.sql`,
  `packages/worker/src/credentials/personal-credentials.ts`) records which org
  each personal credential is granted to. `credential_id` is a credential in the
  owner's personal org, `user_id` is the owner's person id, and the row is
  hard-deleted when the owner leaves that org.
- `credential_mappings` (`0134-credential-mappings.sql`,
  `packages/worker/src/credentials/credential-mappings.ts`) stores which
  credentials one package need resolves to: the org-layer default (`target`
  `org`), one person's own default (`mine`, `person_user_id` set), or one
  trigger instance's override (`enablement`, `enablement_id` set and
  `person_user_id` the enabler). `credential_ids_json` is an ordered array of
  credential ids, and `[]` means "none on purpose". Rows hold ids only. A
  person's rows in an org are hard-deleted when they leave it, and with their
  account.
- `credential_mapping_proposals` (`0137-credential-mapping-proposals.sql`,
  `packages/worker/src/credentials/agent-credential-proposals.ts`) records each
  approvable `credentialMappingPropose` call under the agent that made it: the
  person (`person_user_id`) plus the request credential (`agent_credential_kind`
  and `agent_credential_id`, an MCP OAuth client, CLI client, or API token).
  When that person approves the link, `approved_picks_json` holds the trigger
  picks they approved, as credential ids; `credentialTriggerPickSet` lets the
  same agent set only those. Unapproved rows older than 30 days are dropped when
  that agent proposes again. A person's rows in an org are hard-deleted when
  they leave it, and with their account.
- `approval_bundles` and `approval_bundle_decisions`
  (`0144-approval-bundles.sql`, `packages/worker/src/approval-bundles/repo.ts`)
  store agent-prefilled approval pages (`approvalBundleCreate`). A bundle row
  names the person it is for (`person_user_id`), the agent credential that made
  it (`agent_credential_kind`, `agent_credential_id`), an untrusted note, and
  `items_json`, an ordered array of item keys (`publish:<requestId>`,
  `capabilities:<packageId>`, `credential-picks:<proposalId>`). Item state is
  read live from the item's own tables; a bundle holds no approval state. Each
  approve or deny first claims the item's decision row (`decided_by_user_id`),
  so one request acts per item, then sets `finalized_at`
  (`0145-approval-bundle-decision-finalized-at.sql`) when it is done. Until then
  the row is an in-flight claim, not a decision, and expires after 10 minutes.
  Within a bundle, the first finalized decision wins. Denying a capability set
  or credential proposal changes nothing, so it can still be approved from its
  own page or another bundle. Bundles open for 30 days. A person's bundles in an
  org are hard-deleted when they leave it, and with their account.

### Durable Object id contracts

`idFromName` inputs are Durable Object identity. Changing any of these strings
or tuple layouts creates new objects and strands existing object storage. All
builders are centralized in
`packages/worker/src/user-scoped-durable-object-name.ts` (plus
`durableObjectNameFromParts` in user-scoped Durable Object naming helpers, which
to `durableObjectNameFromParts`).

- `JobManager`: `idFromName(userId)` (no trim).
- `RunLog`: `idFromName(userId)` (no trim); one execution-history DO per user.
- `UserMeter`: `idFromName(userId)` (no trim); one daily-entitlement meter DO
  per user, plus authoritative schema-v4 storage-byte state.
- `StripePlanRefresh`: `idFromName(userId)` (no trim); one ephemeral billing
  reconciliation alarm DO per user.
- `Mailbox`: `idFromName(userId)` (no trim); one email-metadata DO per user.
- `RepoSessionIndex`: `idFromName(userId)` (no trim); one session-catalog DO per
  user.
- `McpClientHub`: `idFromName(userId.trim())`.
- `StorageRunner`: `idFromName(JSON.stringify([userId, storageId]))`.
- `RepoSession`: `idFromName(sessionId)`; the key is not user-prefixed, so every
  RPC must keep validating the catalog row's `user_id`.
- `PackageRealtimeSession`: `idFromName(JSON.stringify([userId, packageId]))`.
- `MCP`: session-keyed by the MCP SDK rather than by user id; OAuth caller
  context is the request-time ownership boundary and `mcp_agent_sessions`
  provides deletion-only enumeration by stable user id.

Storage ids are also stable strings. Changing a form strands the old bucket:

- `exec:{uuid}` — ad hoc execute storage bound on the call.
- `job:package-job:{packageId}:{encodeURIComponent(jobName)}` — package job run
  scratch (`job:{jobId}`; every job id is a package job id).
- `package:{encodeURIComponent(packageId)}` — package bucket behind
  `packageStorage()` / `buildPackageStorageId(packageId)`.
- `{packageId}:facet:{facetName}` — package-app facet StorageRunner buckets.
- `{packageId}:{exportName}:{name}` — package-app internal Durable Object
  namespace StorageRunner buckets.

### KV key contracts

`OAUTH_KV` is provider-owned by `@cloudflare/workers-oauth-provider`; do not put
app-owned keys in it. App-owned `BUNDLE_ARTIFACTS_KV` keys are:

- `source-snapshot:v1:{sourceId}:{publishedCommit}`.
- `source-manifest-snapshot:v1:{sourceId}:{publishedCommit}`.
- `bundle-artifact:v1:{sourceId}:{commit}:{kind}:{artifactName|_}:{entryPoint}`.
  Publish rebuild copies unchanged targets from the previous commit onto this
  new key (D1 identity row retargets) so a partial export bump does not leave
  the new `published_commit` missing artifacts. Stored JSON includes `modules`
  and optional `linkedArtifacts` prefixes whose module groups live under
  `linked-artifact:v1:…` instead of being inlined.
- `linked-artifact:v1:{sourceId}:{commit}:{sha256}`. The `kody:@` dependency
  modules an uploaded build links (`.__kody_linked__/artifacts/…`), stored once
  per commit and content hash. The commit's bundle artifacts list them under
  `linkedArtifacts` and get the modules back when they are read. Deleted with
  the commit's artifacts, the source, or the account.
- `community-snapshot:v1:{listingId}` — retained only for deletion, export, and
  account teardown; live listing trees use the SHA-keyed source snapshot.
- `package-skills-index:v1:{userId}:{packageId}:{publishedCommit}` — per-version
  Agent Skills index (frontmatter + digests, no file contents) written at
  publish; served by Skills-over-MCP to clients that declare the extension.
- `derived-cache:v1:mcp-oauth-refresh-family:{userId}:{grantId}` and
  `derived-cache:v1:mcp-oauth-refresh-replay:{userId}:{grantId}:{tokenHash}` —
  encrypted MCP OAuth refresh-family snapshots used so concurrent hosts sharing
  one client can reuse the previous refresh token without invalidating siblings
  (`packages/worker/src/oauth-refresh-family.ts`). Written with KV
  `expirationTtl` (two hours / one hour). Registered as user-owned KV surfaces
  and prefix-deleted by account deletion; the TTL covers a refresh that races
  deletion.
- `derived-cache:v1:oauth-cimd-last-known-good:{sha256(clientIdUrl)}`: last
  known good Client ID Metadata Document (`{ document, storedAt }`) for a CIMD
  OAuth client, used on any client lookup when the live metadata fetch times
  out, errors, or returns 5xx/429, or 401/403/404 from a host known to refuse
  Worker fetches (`packages/worker/src/oauth-cimd-last-known-good.ts`). Public
  client metadata, not user-owned. Written only after a successful token
  response or approved authorization, with a 14-day KV `expirationTtl`, and
  rewritten at most daily while unchanged.
- `derived-cache:v1:usage-rollups:user:{userId}:asof:{YYYY-MM}` — derived
  per-user usage read model written with KV `expirationTtl`; retention is five
  minutes, so immediate account-deletion cleanup is not required.
- `derived-cache:v1:community-icon:v3:{listingId}:...` — derived community
  listing icon cache; registered as a user-owned KV surface and deleted for a
  user's listings during account deletion (including leftover
  `community-icon:v1` and `community-icon:v2` prefixes).
- `derived-cache:v1:identity-icon:v1:{repoId}:...` — derived repo/package list
  mark cache; registered as a user-owned KV surface and deleted for every
  `entity_sources.repo_id` during account deletion.
- `derived-cache:v1:artifact-head:v1:{namespace}:{repoId}` — default-branch HEAD
  (`{ branch, commit }`) of an Artifacts repo, read by package home, tree, and
  file pages instead of a live binding + REST + git `info/refs` chain
  (`packages/worker/src/repo/artifact-head-cache.ts`). Filled only by a page
  view (5 minute TTL, 1 hour stale-while-revalidate, 60 second TTL when HEAD is
  unresolved); a `cf.artifacts.repo.pushed` event to the cached default branch
  rewrites the commit from the payload, and a push to an unviewed repo writes
  nothing. Retention is the KV `expirationTtl`, so account deletion does not
  clean it up.
- `webhook-dispatch-payload:v1:{userId}:{deliveryId}` — ephemeral ack-mode
  webhook body spill written with KV `expirationTtl` (24 hours) when the
  serialized queue message would exceed 120 KB. Immediate account-deletion
  cleanup is not required because KV enforces the TTL; the queue consumer
  deletes the key after a terminal delivery.
- `platform-settings:v1:reserved-usernames` — platform-owned runtime reserved
  username override (`{ added, removed, updatedAt, updatedBy }`, where
  `updatedBy` is a stable user id). Not scoped by user id; account deletion must
  not remove it. The effective reserved token set is
  `(builtIn ∪ added) − removed`. `removed` cannot unreserve system-email locals
  or `kody`-prefixed built-in names. New username claims match that set
  case-insensitively by exact token or hyphen/underscore-stripped equality;
  compact substrings apply only to KV-added tokens and built-in brand/system
  roots (see [Security](../../security.md)). When the key is missing or
  unreadable, signup-facing checks fail closed to the code-defined built-in
  list. Admins manage it from `/admin/reserved-usernames` and the
  `adminReservedUsernameList` / `adminReservedUsernameAdd` /
  `adminReservedUsernameRemove` capabilities.

Account deletion derives these keys from D1 rows and package ids before deleting
D1 projections. New KV prefixes must add corresponding account-deletion coverage
or a deliberate retention note.

### R2 key contracts

App-owned R2 keys are:

- `community-icon:v3/{listingId}/{commit}/asset` — processed public community
  icon bytes (256px WebP) at the listing's pinned or icon commit. The listing id
  is the public ownership boundary. Account deletion paginates and strictly
  deletes every key under each D1-owned listing prefix, including historical
  `community-icon:v1/` and `community-icon:v2/` revisions.
- `identity-icon:v1/{repoId}/{commit}/asset` — processed list/identity mark
  bytes (256px WebP) for a package or plain repo at its published or indexed
  commit. The Artifacts `repo_id` is the ownership boundary. Account deletion
  paginates and strictly deletes every key under each D1-owned repo prefix.

- `user-avatars/{stableUserId}/{contentHash}.{extension}` — profile avatars.
  Account deletion paginates and strictly deletes the complete stable-user
  prefix, including historical replacements left by earlier cleanup failures.

- `email-raw:v1:{userId}/{messageId}` — raw email MIME for the message row that
  stores this key in `email_messages.raw_mime_key`. Built by `emailRawMimeKey`
  in `packages/worker/src/email/blob-keys.ts`. The `userId` prefix is part of
  the per-user isolation contract; account deletion removes a user's blobs under
  the matching prefix (and any remaining inventoried keys).

- `email-attachment:v1:{userId}/{messageId}/{attachmentId}` — standalone
  attachment bytes (`storage_kind = 'external'`). Built by
  `emailAttachmentBlobKey` in `packages/worker/src/email/blob-keys.ts`. Same
  per-user prefix isolation and account-deletion coverage as raw MIME.

- `files:v1/{ownerId}/{fileId}/{revisionId}` — immutable org-file revision bytes
  in `FILE_BLOBS` by default (or a configured external R2/S3 provider), plus
  optional `{key}/yjs` collaboration checkpoints. Built by `fileBlobKey` in
  `packages/worker/src/files/object-keys.ts`. `collectAccountR2Inventory` lists
  keys from `FileStore.inventory` when `FILE_STORE` is bound. Account deletion
  deletes external-provider objects, then prefix-purges `files:v1/{ownerId}/` in
  `FILE_BLOBS` inside `FileStore.purge` before clearing the catalog.

- `repo-session:{durableObjectId}/…` — ephemeral RepoSession Workspace spill in
  `REPO_SESSION_BLOBS`. Account deletion prefix-purges via each session Durable
  Object. This scratch is excluded from the `r2_object` account-export section;
  canonical repo bytes stay in Artifacts.

- `org-resource-transfers/{fromOrgId}/{toOrgId}/{stamp}-{uuid}.json` in
  `OPERATOR_BACKUPS` — rollback snapshot written by
  [org resource transfer](../../org-resource-transfer.md) apply. Encrypted
  columns stay sealed. Account deletion and org hard purge delete every backup
  naming the owner as source or target; account export skips it because the same
  rows export from D1.

New R2 key prefixes must add corresponding account-deletion coverage or a
deliberate retention note, same as KV. Exportable registered R2 surfaces
(`EMAIL_BLOBS`, `COMMUNITY_ASSETS`, `FILE_BLOBS`) use the bounded `r2_object`
account-export section. Email, avatar, and icon inventory is derived from the
same user-owned D1 or Mailbox rows used by account deletion; file-revision
inventory comes from `FileStore.inventory`. `REPO_SESSION_BLOBS` is registered
R2 but is ephemeral session scratch, so it is purged with the session instead of
exported.

### Vectorize metadata contracts

Vector ids, namespaces, and metadata are conventional and require reindexing
when changed. User-owned vectors use the account's 64-character stable user id
as their Vectorize namespace. Builtin capability vectors use the reserved
`__kody_builtin__` namespace; stable user ids are lowercase SHA-256 hex, so the
reserved value cannot collide with an account. Namespace filtering is the
primary isolation boundary and is applied by Vectorize before search. The
`userId` metadata filter remains mandatory on every user-owned query as
defense-in-depth.

User-owned ids must also stay within Cloudflare Vectorize's 64-byte id limit:
builders first emit the legacy passthrough form when it fits, then fall back to
`{prefix}_sha256:{truncatedHexDigest}` for overlong raw ids. Length checks are
UTF-8 byte checks, not JavaScript string-length checks, and the digest form is
deterministic so upserts and deletes target the same vector.

- Memories: `memory_{memoryId}` in namespace `{userId}`, with metadata
  `{ kind: 'memory', userId, status, category? }`. Memory ids are UUID-like, so
  search parses only the passthrough `memory_` form back to the D1 id.
- Jobs: `job_{jobId}` or `job_sha256:{digest}` with metadata
  `{ kind: 'job', userId }` in namespace `{userId}`. Package-owned job ids
  `package-job:{packageId}:{jobName}` often need the digest form.
- Saved packages: `package_{packageId}` or `package_sha256:{digest}` with
  metadata `{ kind: 'package', userId }` in namespace `{userId}`.
- Builtin capabilities: id is the capability name in namespace
  `__kody_builtin__`, with metadata `{ kind: 'builtin', domain }`.

Search paths query only per-account namespaces plus the reserved builtin
namespace. Vector rows are derived from D1. User-owned memory, job, and
saved-package vectors upsert on write; saved packages also mark
`saved_package_search_index_debt` and reconcile after the response. Each upsert
(write-time or reindex) records a SHA-256 of embedding model, dimensions,
`vectorEmbedFingerprintVersion`, truncated embed text, and canonical Vectorize
metadata in `vector_embed_fingerprints` (`user_id` is the Vectorize namespace:
the account id, or `__kody_builtin__` for builtins). A later upsert with the
same hash skips Workers AI and Vectorize. Metadata is part of the hash so a
memory status or category change still rewrites the vector. `force: true` on the
maintenance body ignores fingerprints and rewrites Vectorize — required after
Vectorize data loss, because a D1 restore still has the skip rows, and after a
pooling-only embedding change (pooling is not in the hash). Bump
`vectorEmbedFingerprintVersion` when the metadata contract changes so hashes
invalidate even if embed text is unchanged. The bounded
`POST /__maintenance/reindex-capabilities` sweep rebuilds requested kinds
(`phases`; omit the field to rebuild every kind), keyset-pages memory, job, and
saved-package rows, rebuilds builtins in their reserved namespace, and returns
before a request-time budget. An incomplete sweep includes `complete: false` and
a `cursor` so the caller can POST again until `complete` is true. Production
deploy CI loops that endpoint with `{ "phases": ["capabilities"] }` after each
production ship so only builtin capability vectors refresh. A full sweep
(embedding-model change, metadata-contract change, or disaster recovery) omits
`phases` or lists every kind. Disaster recovery POSTs `{ "force": true }` so
restored fingerprints cannot skip an empty index.

### `entity_sources` and package import contracts

`entity_sources` is the durable repo pointer table:
`(user_id, entity_kind, entity_id) -> source_id`. Child tables store
`source_id = entity_sources.id`; KV snapshots use that same source id plus the
published commit. `entity_kind` accepts `package` and `repo`. `manifest_path`,
`source_root`, `published_commit`, `indexed_commit`, and
`last_external_check_at` are part of the repo-source synchronization contract
for packages; plain `repo` sources are live-at-HEAD, have no manifest
requirement, and are skipped by the external-push reconcile lane. Package-owned
jobs live in the package repo.

Saved package imports in user code use `kody:@scope/name/export` specifiers:

1. `packages/worker/src/package-runtime/package-import-resolution.ts` parses the
   `kody:@` prefix, the `@scope/name` package name, and an optional export
   subpath (default `.`).
2. Resolution is scoped to the caller's org. Ad hoc execute and saved packages
   must `communityFork` a package from another org (for example `@kody/github`
   from the `@kody` org) into the caller's org before importing or invoking it.
   No scope grants cross-org imports.
3. `packages/worker/src/package-registry/manifest.ts` normalizes export keys and
   resolves them through `package.json#exports`.
4. Static imports are pinned into bundle dependencies at publish time. Literal
   dynamic `import("kody:@...")` calls are permanently rejected by publish
   checks and rewritten to an actionable teaching error at runtime.

Do not change this grammar or static/dynamic distinction without a user-code
migration plan.

### Growth and retention policies

The Worker cron dispatcher runs every five minutes, but
`packages/worker/src/app/retention.ts` gates the general retention job to the
top of the hour. Production dispatches it as its own queue invocation; preview
and local runtimes run it inline. Each hourly run loops in round-robin passes
over the policy tables — every pending table gets one configured batch before
any table gets a second one — until every table is drained or the run's time
budget (`retentionRunTimeBudgetMs`, ~20 seconds measured with `Date.now`) is
exhausted. The first pass always completes so a hot table cannot starve the
others, and per-batch sizes stay small to bound D1 single-writer pressure. A
failed table is skipped for the rest of that run while the other tables
continue; after processing, the run rethrows a single failure or aggregates
multiple failures. Published-bundle scans advance a `(created_at, id)` cursor
past skipped artifacts, including those kept for active repo sessions. These
behaviors are covered by the
[retention failure tests](../../../../packages/worker/src/scheduled/retention-oauth-purge-failures.node.test.ts).
Progress is reported with a one-line `retention-prune` log that includes
batches-per-table counts and whether the budget ran out. The retention module
owns the named constants and manifest, and
`packages/worker/src/app/retention.node.test.ts` fails if a future
growth-pattern D1 table is added without either a policy or a documented
exemption.

Current retention policies:

- `mcp_memory_conversation_suppressions`: keep active suppressions and prune
  expired rows only after they have not been seen for 90 days. The existing
  request-time memory prune may remove expired rows sooner.
- Terminal workflow projections age-prune after 90 days inside the per-user
  `RunLog` DO (`workflow_projections`; see [Run records](../run-records.md)).
- `published_bundle_artifacts`: delete D1 rows and their `BUNDLE_ARTIFACTS_KV`
  blobs only when the row is older than 30 days, its `published_commit` is no
  longer current for any matching `entity_sources` row, no active
  `community_listings` row pins that commit (`pinned_commit`), and there is no
  active repo session for the source. When a row is pruned, the matching
  `source-snapshot:v1:{sourceId}:{commit}` and
  `source-manifest-snapshot:v1:{sourceId}:{commit}` KV keys, and every
  `linked-artifact:v1:{sourceId}:{commit}:` key, are deleted under the same
  safety conditions, so per-commit snapshots do not accumulate indefinitely.
  Ambiguous publish/edit cases are intentionally kept.
- Mailbox `email_delivery_events`: USER events keep 90 days under the per-owner
  DO alarm/admin RPC. System email is governed by the dedicated system-email
  retention job, which prunes messages, external attachment objects, raw-MIME
  blobs, and delivery events older than 90 days in parameter-bounded batches
  within its own time budget, deletes stale `system_email_daily_counters`, caps
  stored system messages at 5,000, and prunes orphan threads. All R2 objects are
  deleted before dedicated metadata; a failure preserves authority rows for
  retry. The four dedicated `system_email_*` tables therefore have explicit
  `alternate_cleanup` dispositions.
- Mailbox `email_messages` / `email_attachments` / `email_threads`: USER
  messages keep 365 days. The DO deletes canonical raw-MIME/external-attachment
  R2 objects before metadata and retries failures. It then prunes orphan
  threads. Derived provider-index cleanup is separately idempotent.
  `system:email` stays on the dedicated D1 retention job and has no
  provider-index rows.
- UserMeter daily counter rows keep fourteen UTC days
  (`userMeterDailyCounterRetentionDays`); `adminUserMeterParity` reports
  meter-only daily counts.
- `usage_rollups`: per user/metric/month rollups keep 24 months by `month` key;
  raw Analytics Engine usage events follow platform retention.
- `usage_connection_daily`: per org, UTC day, connection (credential kind,
  holder person, credential id), package, and event type. The hourly usage
  aggregation lane rewrites yesterday and today from Analytics Engine and prunes
  days older than 14. Deleted and exported with the account (`holder_user_id` is
  a person column).
- `user_usage_campaigns` / `user_usage_campaign_sends`: usage-state campaign
  machine and send ledger keyed by `stable_user_id`. `ever_activated` and
  `cooling_terminal` are sticky. Deleted and exported with the account. Durable
  until deletion; no TTL.
- `user_tips_email_opt_outs`: Kody tips opt-out stamp keyed by `stable_user_id`.
  Deleted and exported with the account. Durable until deletion; no TTL.
- `durable_object_duration_daily`: per-user, per-DO-class, per-UTC-day
  Cloudflare-measured active milliseconds (absolute; the hourly attribution lane
  rewrites yesterday and today). Deleted and exported with the account.
  `durable_object_duration_coverage_daily` is the fleet-level attributed vs
  total companion (no user data).
- `credit_wallets`: one prepaid credit wallet per owner id (`user_id` is the org
  id; personal orgs reuse `stable_user_id`). Balance in micro-USD, auto-refill
  settings and saved card id, notice opt-outs.
- `credit_ledger_entries`: append-only top-ups, auto-refills, admin grants (with
  `granted_by_user_id` and `note`), and debits. `stripe_reference` is unique for
  idempotent Stripe credits. Deleting an admin anonymizes `granted_by_user_id`
  to `deleted-user` on recipients' rows.
- `credit_debit_progress`: per user, UTC month, and debit meter, the billable
  units above the include already debited or forgiven, so hourly debits stay
  idempotent. All three credit tables are durable forever until account
  deletion/export.
- `feature_flag_exposure_rollups`: local-dev/test flag exposure rollups keep 90
  days by `day` key, matching Analytics Engine retention for the production
  `FLAG_EXPOSURES` exposure stream; the admin metric readout window is the
  current month.
- `platform_feedback`: open and triaged rows remain until review changes them to
  resolved or dismissed, or the submitter deletes their account. Resolved and
  dismissed rows keep 365 days after `updated_at`; submitter deletion removes
  any remaining rows.
- `audit_events`: global hashed auth/security audit events live only in the
  dedicated `AUDIT_DB` database. All persisted writes, admin reads, insights,
  and auth-denial alerts use that binding; the hourly retention lane prunes rows
  after 180 days. Audit events are not user-owned and remain independent of
  account deletion/export.
- `stripe_webhook_events`: platform Stripe webhook idempotency rows keep 30 days
  by `processed_at`. They are not user-owned and remain independent of account
  deletion/export.
- `agent_package_conversation_uses`: per-user package conversation-use rows keep
  180 days by `last_used_at` (`agentPackagePopularityMaxAgeDays`). The prune
  orders by the existing `(user_id, last_used_at)` time index via `last_used_at`
  then `rowid`.
- Unverified person accounts: password signups that stay unverified
  (`users.email_verified_at` is null) for seven days and have no
  `oauth_connections` row are deleted by the hourly `unverified_account_purge`
  lane. Soft-deleted rows (`deleted_at` set) are out of scope for both its scan
  and its claim: the shared
  [eligibility predicate](../../../../packages/worker/src/account/unverified-account-purge.ts)
  requires `users.deleted_at IS NULL`, leaving the restore window and hard
  deletion to the soft-delete purge lane. Each run selects a bounded batch of
  never-attempted rows first, then oldest `created_at`, skipping rows whose
  `deleting_at` is inside a retry backoff. Before deletion it claims the row
  atomically (restamping `deleting_at` only while eligibility still holds). Once
  claimed, verify-email and social-login reclaim refuse the fenced account. A
  claim-created fence is released only on pre-cleanup failures; a
  partial-cleanup failure leaves the fence for retry. Outcomes are recorded
  best-effort: a purge writes an `unverified_account_purged` audit row and a
  failed deletion writes an `unverified_account_purge_failed` audit row (reason
  `<ErrorClassName>: <first inventory/cleanup warning or message>`, email
  addresses redacted, at most 200 characters) plus a Sentry event when Sentry is
  configured. Either sink being unavailable is logged and skipped rather than
  failing the batch, so the durable record can have gaps when `AUDIT_DB` is
  down; the on-demand capability below is the authoritative read. The admin-only
  `adminUnverifiedAccountPurgeRun` capability runs one bounded pass on demand
  (or previews the claim page with `dryRun`) and returns per-account outcomes
  keyed by stable user id. Social-login accounts are verified at creation and
  are not in this set. An account that is the only Owner of a team org with
  other members is skipped (`skipped_sole_owner`); see
  [organizations a deleted person leaves behind](./account-lifecycle.md#organizations-a-deleted-person-leaves-behind).

The squashed baseline defines the global time-column indexes these prunes order
by (`created_at` / `day` / `month` / `started_at` across users); per-user
composite indexes cannot serve those ordered scans.

Documented exemptions: `jobs` are package-owned and stay until package sync,
package deletion, or account deletion, and `mcp_memories` is exempt because
memories are durable user-curated content removed by explicit user action or
account deletion rather than by time-based retention.

# Org resource transfer

`adminOrgResourceTransfer` moves every resource one org owns to another org:
packages, repos, sources, secrets, values, integrations, BYO OAuth apps, MCP
servers, webhooks, package jobs, and package storage. Memories are personal:
they stay with their owning user and are never moved to another org, including
when the source is a personal org. Use it when an owner approves consolidating a
personal org into a team org, or the reverse.

It is an admin capability. It is destructive, audited on both orgs, and runs
only through `execute`; never call it from package or user code.

```ts
await kody.adminOrgResourceTransfer({
	fromOrgId: 'org_source',
	toOrgId: 'org_target',
	mode: 'dry-run', // then 'apply'
	skipOrphans: false,
	// On apply: the fingerprint of the dry-run you reviewed.
	expectedFingerprint: undefined,
})
```

The engine lives in `packages/worker/src/org-transfer/`.

## What moves and what stays

`packages/worker/src/org-transfer/tables.ts` classifies every owner-keyed APP_DB
table as `move` (with how) or `keep` (with why). A test fails when an account
data target is missing from that map, so a new owner-keyed table needs a
deliberate decision.

These stay with the source org:

- Memories (personal-only), including conversation suppressions and memory
  vectors. Shared org knowledge belongs in documented packages and org
  instructions.
- Email inboxes, addresses, sender identities, and notification destinations.
- Usage, credit, and billing history, `RunLog`, and `UserMeter`.
- Person-owned rows (logins, passkeys, API tokens, OAuth clients).
- Org structure (memberships, invites, teams, handles, limits).
- Codemod run history and live MCP sessions.
- Session-scoped secret and value buckets.

Packages are renamed to `@<target slug>/<kody id>` in the registry. Their
sources still say the old scope, so run codemod
[`0011-owner-scope-follows-registry`](./package-codemods.md#0011-owner-scope-follows-registry)
after the transfer.

## Dry-run

Dry-run reads both orgs and returns a summary of counts and names only: package
renames, repos, secret and value names with their scope, integrations, OAuth
apps, MCP servers (`{id, name}`), webhooks, enablements, jobs, storages to copy,
orphans, clashes, blockers, and warnings. It never returns row values.

- `webhooks`: each entry has `url_changed: true`, `old_path_prefix`,
  `new_path_prefix`, and `manage_path`. Public webhook URLs embed the owner slug
  (`/@<slug>/webhooks/<kody id>/<name>/<url secret>`), and the URL secret moves
  with the endpoint, so the new URL is the old URL with the old prefix swapped
  for the new one. The URL secret segment is never in the output.
- `enablements`: package, `trigger_kind`, `trigger_name`, `state`,
  `enabler_user_id`, and `enabler_is_target_member`.
- `jobs`: id, name, package, and the schedule summary.
- `clashes`, `blockers`, and `warnings` are findings:
  `{ code, message, table?, subject? }`. `subject` names the row (a package,
  secret, or server name) or, for post-commit warnings, the step. The codes are
  listed in `packages/worker/src/org-transfer/findings.ts`.
- `kept.memories`: `{ count, note }`. `count` is the live memories the source
  owns (`deleted_at` is null), and it is present when that count is zero. `note`
  says memories are personal and stay with their owner. Conversation
  suppressions, memory vectors, and memory embed fingerprints are left
  untouched. `skipOrphans` does not delete them.
- `refusals`: the findings apply would refuse on (see the list that follows).
- `fingerprint`: SHA-256 of the summary, with keys and list entries sorted. The
  same plan always has the same fingerprint. It covers what an operator can
  review (names, counts, destinations, findings), not values: secrets, tokens,
  and storage contents move as they are when apply runs. Integration tokens
  refresh on their own, so a fingerprint over values would drift constantly.

Apply refuses when the plan has any of these:

- Clashes: the target already has a package, repo, secret, value, integration,
  OAuth app, MCP server, or webhook with the same identity. Clashes also cover a
  server id already registered in the target's McpClientHub, and a target
  StorageRunner that already holds data.
- Blockers: resource grants naming source-org subjects, trigger enablements by
  someone outside the target org, an integration whose OAuth app is not live, or
  an MCP server with no connection in the source hub.
- Orphans, unless `skipOrphans: true` (`orphans_present`).
- A fingerprint other than `expectedFingerprint`, when it is passed
  (`plan_drifted`). Pass the fingerprint of the dry-run you reviewed, so apply
  never moves something nobody reviewed.

A refusal is returned, not thrown: `outcome: 'refused'` with `refusals`. Input
errors (the same org twice, an org that is not live or is suspended) still
throw.

Both orgs must be live (not deleting, deleted, or suspended), and they must
differ.

## Orphans

An orphan is a row whose parent no longer exists, such as an `entity_sources`
row for a deleted package or a webhook endpoint whose package is gone. With
`skipOrphans: true` the transfer does not move orphans; it cleans them up in the
source org instead:

- Soft-deleted in the D1 batch: webhook endpoints, community listings, secret
  and value buckets, and secret-provider bindings.
- Deleted in the D1 batch: published bundle artifacts, Artifacts push
  subscriptions, community forks, secret-provider grants, and package kody-id
  and slug redirects.
- Cleaned up after commit: sources are deleted with their Artifacts repos.
  Storage buckets are cleared on their StorageRunner and then deleted, like
  package delete. A soft-deleted bucket would keep its `(user_id, storage_id)`
  key and block a later transfer back.

## Apply

Apply holds the account write lease on both orgs (taken in id order) for the
whole run, re-plans under the lease, and refuses on anything the dry-run would
refuse. Then, in order:

1. Re-seal every encrypted column under the target owner's key context: secret
   and value entries, integration access and refresh tokens, OAuth app client
   secrets, and webhook URLs and HMAC secrets. Each value is decrypted and
   checked after re-sealing.
2. Write a backup of every affected row (ciphertext included) to the
   `OPERATOR_BACKUPS` R2 bucket. Apply fails closed when the binding is missing.
3. Copy OAuth app logos under the target owner.
4. Copy every moved package, job, and storage bucket's StorageRunner. KV values
   travel by structured clone, so Dates, Maps, and typed arrays survive. Then
   verify KV entry counts and SQL row counts per table.
5. Stage McpClientHub servers (tokens included) in the target hub in one storage
   write. A staged server is not registered, so nothing (not even a hub restart,
   which redials every registered server) can connect it before commit. An undo
   drops the staged server and its keys without touching the rest of the hub.
6. Re-point package jobs in the jobs worker.
7. Commit every APP_DB change in one D1 batch, with an
   `org.resources_transferred_out` / `org.resources_transferred_in` audit event
   on each org and an `access_epoch` bump on both.

If any step before the batch commits fails, completed steps are undone in
reverse order and the result is `outcome: 'failed'` with:

```ts
failure: {
	committed: false,
	failed_step: 'reseal' | 'backup' | 'logo_copy' | 'storage_copy' | 'mcp_import' | 'jobs_transfer' | 'commit',
	failed_undo?: Array<string>, // undo steps that also failed; finish them by hand
	backup_key: string | null, // null before the backup step; may not exist if the backup step failed
	message: string,
}
```

The top-level `backup_key` carries the same key. A refused or failed apply is
audited as a failure, with the step, failed undos, and backup key in the audit
reason.

Nothing in APP_DB moved. With `failed_undo`, the target may hold stray copies
(storage, logos, a staged MCP server) that the named steps did not remove.

After commit, best-effort cleanup runs: source storage is cleared, each moved
MCP server is removed from the source hub with all its keys (without first
redialing it, when the source hub has not started yet) and only then registered
and connected in the target hub, so only one hub can refresh its OAuth tokens;
old logos are deleted, orphans cleaned, repo sessions on moved sources
discarded, package and job vectors reindexed under the target, and the
retriever, skills, subscription, invoke-contract, and community caches
refreshed. Failures there come back as `post_commit_warnings` (code
`post_commit_step_failed`, `subject` naming the step), and `leftovers` counts
any rows still pointing at the source.

The result has `outcome` (`planned`, `refused`, `failed`, or `applied`),
`fingerprint`, the dry-run summary (including `kept.memories`), `refusals`,
`failure`, `backup_key`, `storage_copies`, `leftovers`, `post_commit_warnings`,
and `mcp_connections`.

`mcp_connections` has one entry per moved MCP server after the target hub dialed
it: `{ id, name, source_removed, state, needs_authorization, authorize_url }`.
`state` is null when the connect step failed. `source_removed: false` means the
source hub still holds the server, so both hubs may refresh its tokens; remove
it from the source by hand. When `needs_authorization` is true, `authorize_url`
is the Kody consent page in the target org
(`/@<target>/-/mcp-servers/<id>/authorize`), never the provider's URL.

## What the owner redoes

- MCP servers with `needs_authorization` need the owner to open `authorize_url`.
- Webhooks: update every external sender to the new URL (swap `old_path_prefix`
  for `new_path_prefix`). The old URL stops resolving.
- BYO integration OAuth apps need no change. Their redirect URI is
  `<origin>/connect/oauth`, with no org slug, so the URI registered with the
  provider keeps working. The remote MCP server OAuth callback
  (`<origin>/account/mcp-servers/oauth/callback`) has no slug either.

## Secret values

Secret values, tokens, and client secrets stay inside the worker. They are never
returned, logged, or included in error messages, and they never enter package or
user code. Decrypt failures use the generic secret errors.
`packages/worker/src/org-transfer/reencrypt.ts` is the only transfer module
allowed to touch the credential crypto boundary.

## Backups

Backups live at
`org-resource-transfers/<fromOrgId>/<toOrgId>/<stamp>-<uuid>.json` in
`OPERATOR_BACKUPS`. They hold row data with encrypted columns still sealed under
the source key context, so restoring means writing those rows back as they were.
Account deletion and org hard purge delete every backup that names the owner as
source or target. Account export skips them because the owner already exports
the same rows from D1.

McpClientHub connections move DO to DO in memory and are not in the backup. The
target hub does not dial a moved server until after commit, so an undo never
follows a refresh by the target. The source stays connected until after commit;
if it refreshes a rotating token during apply, the target's copy is stale and
that server needs reconnecting.

## Production runbook

1. Confirm the owner's approval and both org ids.
2. Dry-run. Resolve clashes and blockers with the owner; decide on orphans.
3. Apply with `expectedFingerprint` set to the reviewed dry-run's fingerprint.
   Check `outcome`, and record `backup_key` in the operator log.
4. Check `leftovers` is empty and review `post_commit_warnings`.
5. Send the owner the follow-ups: `mcp_connections` that need authorization and
   the changed webhook URLs.
6. Run codemod `0011-owner-scope-follows-registry` dry-run, then apply, with
   `userIds` set to the target org id.
7. Spot-check that a moved package runs, its secrets resolve, and its storage
   reads back.

## Related

- [Package codemods](./package-codemods.md)
- [Data storage](./architecture/data-storage.md)
- [Disaster recovery](./disaster-recovery.md)
- [Account write lease repair](./account-write-lease-repair.md)

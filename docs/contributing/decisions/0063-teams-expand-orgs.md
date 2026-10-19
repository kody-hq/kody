# 0063 — Teams P3 expand adds org rows without moving storage keys

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Teams phase 3 (**expand**) introduces `orgs`, `org_memberships`, and `handles`
in APP_DB while every existing resource keeps its current owner id. Personal
orgs reuse `users.stable_user_id` as `orgs.id`, so Durable Object names, KV/R2
keys, and D1 `user_id` columns do not re-key. Billing and profile columns are
copied onto org rows; `users` columns stay until a later contract change.
Soft-delete columns land additively; enforced read filters are phase 7.

## Decision

- **Migrated and new personal orgs** use `orgs.id = stable_user_id`. New signups
  provision org + owner membership + handle in the same flow as user creation.
- **Request context** loads org binding from D1 where the session/MCP OAuth path
  has APP_DB (`loadOrgBindingForPerson`). Sync call sites without DB still use
  `resolveOrgBinding` → `personalOrgId` until phase 4 passes `orgBinding`
  everywhere.
- **Entitlements** read billing columns from `orgs` first, with a logged
  fallback to `users` if a row is missing. Writes that change plan, Stripe, or
  related entitlement columns dual-write to `orgs` with the same id.
- **Handles** share the username namespace and are permanent: a personal org's
  slug is the username chosen at signup and a team org's slug is the one chosen
  at creation. Neither can be renamed afterwards; only display names change.
  Handles left behind by renames that happened before this rule stay reserved.
- **Org audit** (`org_audit_events` in AUDIT_DB) is separate from platform
  `audit_events`. Backfill records `org.migrated` per org.

Storage reads and usage billing that have an org on the request use
`ownerIdFromCaller` (`request.org.id`). A team org's Repositories page lists the
packages that org owns, filtered by `canSeeResource`; the signup org keeps the
person's profile list. Connected agents are grants held by the person; an org
page lists the ones bound to that org (`metadata.orgId`). We do **not** yet
filter every soft-deleted org row on reads, or drop legacy `users` billing
columns.

## Consequences

[ADR 0060](./0060-owner-and-person-ids.md) still governs id types; org
membership is now the DB-backed source for “which org” on interactive paths,
while `personalOrgId` remains the sync fallback. Follow-up phases wire team
grants, org switching, storage key migration, and soft-delete enforcement.

`org.migrated` rows were an operator command, not a deploy step.
`backfillOrgMigratedAuditEvents` wrote one success row per org, and a repeat
inserted nothing new. That backfill finished on production (2026-10-10) and the
one-off tooling was removed.

## Amendment (2026-10-14)

Issue [#3053](https://github.com/kentcdodds/kody/issues/3053) separates a
person's stable id from their personal org id in three expand/contract phases.
Existing personal orgs keep `orgs.id = stable_user_id` forever; this does not
move their storage keys.

- **Phase 1 (widen).** `users.personal_org_id` is added, backfilled to
  `stable_user_id`, and dual-written on signup. `orgs.id` still equals the
  person id. `personalOrgId()` stays the identity cast.
- **Phase 2 (switch).** Readers use `users.personal_org_id` / `request.org.id`
  (SQL joins, binding, `isPersonalOrg`, write-lease fence, stamped
  `mcpUser.personalOrgId`). New signups mint `orgs.id` distinct from
  `stable_user_id`. Existing personal orgs keep equal ids.
- **Phase 3 (narrow).** `personalOrgId(person)` is no longer the personal-org
  resolver; it remains only a person→`OwnerId` brand for **person-keyed**
  storage. Org-keyed readers use `personalOrgIdForPerson` /
  `personalOrgIdFromUserRow` / `loadPersonalOrgIdForPerson` / `request.org.id`
  (blank-column / unstamped callers still equal-id fall back for fixtures).
  Migration `0146` re-asserts live rows have a non-blank `personal_org_id`.
  Existing personal orgs still keep `orgs.id = stable_user_id` forever (no data
  moves).

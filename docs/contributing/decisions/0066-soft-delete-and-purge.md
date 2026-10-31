# 0066 — Teams soft delete, restore window, and purge lane

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Teams phase 7 completes soft delete started in phase 3 expand (`deleted_at` /
`deleting_at` columns on org-owned APP_DB rows and jobs). Live reads must not
return tombstoned rows; purge must hard-delete after a retention window without
a long-lived feature flag or dual read paths.

## Decision

- **Soft delete** sets `deleted_at` (and optionally `deleting_at` while purge
  claims work). **Restore** clears those columns when `deleted_at` is within
  **30 UTC days** (`softDeleteRetentionDays`).
- **Live reads** on every APP_DB / JOBS_DB table with `deleted_at` append
  `deleted_at IS NULL` via `liveDeletedAtSql` helpers; a static scanner
  (`tools/soft-delete-read-filter.ts`) enforces this on `prepare` / `exec` SQL.
  Restore, purge, and soft-delete writers opt out file-wide with
  `soft-delete-read-filter: opt-out`.
- **Purge** runs in a dedicated lane: rows past the retention cutoff are
  hard-deleted; `deleting_at` marks in-flight purge claims. **Org delete** and
  **user offboarding** are separate flows (org vs person scope).
- **Same-email signup supersedes** a soft-deleted account once the address is
  proven: a verified provider email (Google etc.), a mailed release link
  (password signup sends one instead of creating the account), or an admin.
  Superseding moves its email and username to released tombstones and frees its
  email claims, provider links, handles, personal org slug, and inbox addresses
  (`releaseSoftDeletedAccountsForEmail`). Ids and owned rows stay for purge; the
  superseded account and its personal org can no longer be restored. Until then
  the email and handle stay reserved.
- **Purge audit** appends to `org_audit_events` (AUDIT_DB, **1 year**
  retention). First production purge enable is **dry-run** (log only, no hard
  deletes).
- We do **not** add a feature flag for soft-delete reads; one enforced filter
  path only.

## Consequences

Table lists and SQL helpers live under `packages/worker/src/soft-delete/`.
Filter rollout must clear scanner violations before merge gates the production
tree. Purge/offboarding implementation stays in follow-up PRs; this record
steers retention, audit, and the no-flag enforcement model.

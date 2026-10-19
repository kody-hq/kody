# Soft delete (Teams P7 foundation)

`tables.ts` is the single source of truth for D1 tables that carry `deleted_at`.

Live reads must exclude soft-deleted rows:

- Prefer `liveDeletedAtSql` / `andLiveDeletedAtSql` / `withLiveDeletedAt` in D1
  SQL.
- `tools/soft-delete-read-filter.ts` scans `packages/worker/src` and
  `packages/jobs-worker/src` for `prepare` / `exec` literals that touch those
  tables without a live filter.
- Production-tree enforcement is `npm run soft-delete-read-filter:check` (also
  part of `npm run validate` and the CI static job). See ADR 0064.

Restore, purge, and soft-delete writers may opt out file-wide with a comment
containing `soft-delete-read-filter: opt-out` (see
`softDeleteReadFilterOptOutMarker` in `live-sql.ts`).

Retention and purge cutoff helpers live in `window.ts`
(`softDeleteRetentionDays` = 30).

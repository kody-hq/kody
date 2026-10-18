# Authoring D1 migrations

Naming, ledger rules, and what not to edit after a migration lands. See the
[setup index](./index.md) for the other setup pages. Remote apply examples live
in [Seed test account](./seeding.md).

- New migration files live in `packages/worker/migrations/` and are applied in
  lexicographic filename order by Wrangler (`npm run migrate:local`,
  `migrate:e2e`, and the documented `d1 migrations apply APP_DB --remote`
  invocations in [Seed test account](./seeding.md)).
- Name new files `NNNN-kebab-case-description.sql` (four-digit prefix, hyphen,
  kebab-case slug). Pick the next prefix as `(max numeric prefix) + 1`,
  zero-padded to four digits (for example, if the highest prefix is `0075`, use
  `0076-my-change.sql`). `npm run migrations:check` prints that prefix. When
  `GH_TOKEN` or `GITHUB_TOKEN` is set, or the `gh` CLI is logged in, it also
  lists prefixes claimed by other open pull requests against the base branch
  (`GITHUB_BASE_REF`, otherwise `main`) and prints the lowest prefix that is
  free of both this checkout and those claims. The listing is advisory: missing
  auth or a GitHub error does not fail the check, and gaps in the sequence stay
  allowed. CI passes the workflow token into this scan.
- If your branch is behind `main` and a new migration has landed upstream with
  the prefix you picked, rebase and renumber your file to a new unused prefix.
  Do not introduce new duplicate prefixes. PR preview D1s that already applied
  the old filename are healed by
  `tools/ci/rewrite-renamed-preview-migrations.ts` (sha256 match) before preview
  `d1 migrations apply`; see
  [PR preview deployments](./preview-deploys.md#migration-renumber-race-on-an-existing-preview-d1)
  for the reset-preview-D1 fallback when rewrite is unsafe. Local state dirs
  (`.wrangler/state`, `.wrangler/state/e2e`) are not rewritten:
  `tools/check-stale-local-migrations.ts` runs before each local apply and fails
  when `d1_migrations` records a filename that is no longer on disk, naming the
  stale file and the `rm -rf <state dir>` reset to run before retrying.
- Do not edit migration files that have already landed in `main` and been
  deployed. New migration files that only exist on your branch can be revised
  freely until they land in `main`; once deployed, any schema correction should
  ship as a new migration instead. Exception: when production (or another
  durable remote) rolls back a migration before `d1_migrations` records it — so
  the SQL never applied — you may replace that file's contents and ledger digest
  only by listing the prior digest in `tools/migration-repairs.json`
  (`filename`, `fromSha256`, `reason`). That allowlist is one-shot per digest;
  remove the entry after the repair lands on `main` if you want a tidy tree.
- `npm run migrations:check` (also run by `npm run validate`, and by the
  pre-commit hook when the staged diff is not docs-only) enforces the naming
  rules above against the checked-in, append-only `tools/migration-ledger.json`.
  It also flags `NNNN-kebab.sql` references in `docs/` and
  `packages/worker/src|universal` (including `.tsx`) that do not name a file in
  `packages/worker/migrations` (or the jobs/audit migration directories), so a
  renumber cannot leave a dangling docs or test name. Instructional placeholders
  such as `0076-my-change.sql` are allowed. Decision records and dated audits
  are exempt because they are point-in-time. When adding a migration, append its
  filename and SHA-256 digest to the ledger; never edit or remove an existing
  ledger entry. The check compares historical entries and SQL contents with a
  pre-change Git commit: CI supplies the PR base or push-before SHA, local
  branches use their `main` merge base, and main/detached checkouts fall back to
  the first parent. `HEAD` itself is never trusted. CI fetches complete history;
  local and cloud checkouts must retain or fetch `origin/main`. If no pre-change
  commit is available, validation fails safely once migrations exist beyond the
  frozen bootstrap baseline. Migration SQL is hashed with canonical LF line
  endings, and `.gitattributes` enforces LF checkouts.
- Duplicate prefixes are always rejected. The 2026-08-04 migration-history
  squash collapsed the pre-launch history into `0001-squashed-init.sql` (full
  schema plus migration-seeded platform rows); the pre-squash files remain in
  Git history only. `tools/ci/reset-migration-bookkeeping.ts` is the
  deterministic guard that rewrote `d1_migrations` bookkeeping in existing
  databases — it verifies the applied set matches the frozen pre-squash list
  exactly before touching anything, and no-ops on fresh or already-squashed
  databases. The guard runs only for local applies against pre-squash developer
  state dirs; delete it once those have died out.
- Leftovers this migration cannot drop yet (old columns, dual-write, a later
  `deleted_classes` tag, a soak) follow
  [Cleanup after migrations](../cleanup-after-migrations.md): remove them in
  this change when safe, otherwise open a GitHub issue.

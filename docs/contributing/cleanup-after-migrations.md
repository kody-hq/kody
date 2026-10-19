# Cleanup after migrations

Agents clean up leftover cruft from the change they are making. Untracked
leftovers linger; tracked leftovers get finished. This page is the policy when
work introduces a transitional leftover, a deprecated path, a soak, or a
follow-up migration.

## Decision

1. **Remove it in this change** when the leftover is safe to drop with the
   landing code: unused helpers, dead call sites, docs that describe the old
   path, tests that only exist to keep a shim green, feature-flag branches whose
   gate already passed, columns the app no longer reads or writes.
2. **Open a GitHub issue** when the leftover cannot go in this change. Typical
   gates: a later schema drop, a second deploy (Cloudflare Durable Object class
   deletion), a metrics or soak window, a fleet codemod, or another team's
   cutover. A runbook can describe the steps; the issue is the tracker so the
   leftover is not forgotten.

Do not leave a "we can clean this up later" comment, a TODO, or a runbook
paragraph as the only record.

## What counts as leftover

Anything this change keeps around only because something else has not finished:

- Unused D1 columns, tables, or indexes after a backfill
- Dual-write or dual-read paths
- Compatibility shims, deprecated aliases, and dual-lane serving
- Feature flags whose rollout is complete
- Durable Object classes that a later `deleted_classes` migration must drop
- Codemod deprecation shims after fleet apply and publish-time enforcement
- One-off guard scripts that only apply to old local or preview state
- Docs, MCP instructions, and tests that exist only to explain the old path

A leftover you did not introduce is still worth removing when it is in your
diff's way and safe. Do not expand a multi-track program into dropping an old
system unless that is the assigned work; still file an issue for leftovers
**this** change adds.

## Issue

Search open issues first (`Cleanup:` title prefix) and comment on a match
instead of opening a duplicate.

Title: `Cleanup: <what to remove> after <gate>`.

Label: `improvement`.

Body:

```markdown
## Leftover

What to delete or stop serving (paths, tables, flags, shims, classes).

## Why it waits

The gate: soak metric, subsequent migration, deploy order, fleet apply, or other
cutover.

## Ready when

A falsifiable criterion. Not a calendar date alone.

## How to verify

Commands, queries, or deploy evidence that prove the drop is safe.

## Introduced by

PR that added the leftover.
```

Link the issue from the introducing PR description with `Related to #N` or a
plain link. Never write `does not close #N` — GitHub still treats `close #N` as
a closing keyword even after "does not". If a runbook exists, link both ways.
When the cleanup later lands, close the issue.

Create with `gh issue create` from a repo checkout, or
`kody:@kentcdodds/github/request` `POST /repos/kody-hq/kody/issues`.

When the gate is a soak or calendar window, also schedule a wake (`execute` +
`workflows.create({ runAt, idempotencyKey })`) as in the
[ship-pr skill](../../.agents/skills/ship-pr/SKILL.md). The issue remains the
durable tracker after the session ends.

## Related

- [Authoring D1 migrations](./setup/migrations.md)
- [Package codemod rollout](./package-codemods.md#rollout-doctrine)
- [Harness engineering](./harness-engineering.md)
- [Values retirement runbook](./architecture/values-retirement-runbook.md)
- [Runtime worker migration runbook](./architecture/runtime-worker-migration-runbook.md)
- [Platform worker migration runbook](./architecture/platform-worker-migration-runbook.md)
- [Jobs worker migration runbook](./architecture/jobs-worker-migration-runbook.md)

# 0032: No unattached jobs

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Jobs and workflows overlapped as authoring units. `job_schedule` /
`job_schedule_once` created repo-backed schedules that were not a package
(`entity_kind: 'job'`). Workflows already cover deferred one-shots
(`workflows.create({ runAt })`). Packages already own recurring schedules
(`kody.jobs`). Agents were told "scheduling alone is not a reason to package."

Production `kody-jobs` on 2026-08-21: 118 rows, 84 unattached, 17 live
unattached across 7 accounts. Community listings and saved-package search text
did not call `job_schedule`. Recurring unattached jobs cannot become workflow
chains without inventing workflow cron (a thinner twin).

## Decision

Do not author schedules outside a package. Recurring and interval work is a
package job. Deferred or long-running one-shot work is a workflow started from
`execute` or package runtime. Do not add workflow cron, a `schedule()` wrapper
package, or an unattached-job capability.

`jobList`, `jobGet`, `jobRunNow`, and metadata `jobUpdate` operate on package
jobs only. A job is removed by deleting it from `package.json#kody.jobs` and
publishing; there is no `jobDelete`.

## Consequences

MCP, `/account/jobs`, usage docs, and discovery evals describe package jobs and
workflows only. `/account/workflows` is a view over existing
`workflow_projections`, not a new primitive. Revisit only if a recurring
schedule must exist without a package _and_ without a workflow — that has not
shown up in the fleet.

## Amendment: unattached rows retired

There is no Owner-only re-enable path for unattached rows (#3401). The last
unattached rows were moved into private package jobs in their owner's org or
deleted after the owner was notified. `adminLegacyJobsRetire` was used at deploy
time for that one-shot and is gone. The code that existed only for those rows
went with them: the enablement backfill branch for non-package jobs, the
`kody.json` job source sync and templates, `jobDelete`, the job retention
sweeper and `preserved` flag, and the `/account/jobs` delete, retention, and
enable toggles. The jobs D1 now asserts every row id is a `package-job:` id, and
the runner throws on any job that is not a package job.

## Amendment: once schedules retired

Package `once` jobs overlapped durable workflows and have been removed from the
schedule schema, runner, MCP capabilities, and jobs UI. Publishing now rejects
them with guidance to use `workflows.create` for deferred one-shot work.
Migration 0008 deletes stored once-schedule job rows that are disabled, already
ran, or deleted, and asserts that no enabled, never-run once jobs remain.

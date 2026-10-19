# Jobs worker migration runbook

Production owns `JobManager`, `JOBS_DB`, and the five-minute cron on
`kody-jobs`. `transferred_classes` is a one-shot cutover; do not invent a second
transfer or add `deleted_classes` for `JobManager`.

This page records current ownership and the invariants later deploys must keep.

Operational notes for the dedicated jobs worker (`packages/jobs-worker`, ADR
[0016 — Mono-worker extraction](../decisions/0016-mono-worker-extraction.md)).
Later deploys follow `.github/workflows/deploy.yml`. Do not re-run the Durable
Object transfer or a bounded D1 copy against live production.

## Ownership

| Concern                                                          | Owner                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `JobManager` Durable Object (per-user scheduling state + alarms) | `kody-jobs`                                                        |
| `jobs` table                                                     | `JOBS_DB` on `kody-jobs`                                           |
| Five-minute cron and `kody-scheduled-dispatch` queues            | `kody-jobs`                                                        |
| Job execution / scheduled lanes (`JobsHost`)                     | `kody` (origin); `kody-jobs` calls back through the `HOST` binding |
| Job reads and writes from origin / MCP / dashboards              | `JOBS` service binding (`JobsService`) on origin                   |

`APP_DB` has no `jobs` table. The schema change is
`packages/worker/migrations/0010-drop-jobs-tables.sql`. Live authority is
`JOBS_DB`. Do not query `jobs` on `APP_DB`, do not copy it "one more time," and
do not treat 0010 as a waiting follow-up. `archived_job_artifacts` was dropped
from `JOBS_DB` by `0005-drop-preserved-and-archived-artifacts.sql`.

## Invariants

- Do not add another `transferred_classes` row for `JobManager`. The `v1`
  transfer already applied on production `kody-jobs`
  (`packages/jobs-worker/wrangler.jsonc`,
  `{ from: "JobManager", from_script: "kody-production", to: "JobManager" }`).
- Never add `deleted_classes` for `JobManager`. That destroys transferred
  per-user DO storage. Deploy guardrails allowlist any `deleted_classes` edit.
- Object IDs derived from user IDs stay valid because the namespace moved with
  the class. Do not recreate `JobManager` on origin.
- Service bindings are by deployed worker name (wrangler appends the
  environment, so the production main worker script is `kody-production`):
  origin reaches the jobs worker through `JOBS` (`JobsService`) and `kody-jobs`
  calls back through `HOST` (`JobsHost`). The jobs worker must exist before a
  main-worker deploy that declares the `JOBS` binding can validate, which is why
  `.github/workflows/deploy.yml` deploys the jobs worker first when jobs sources
  change.
- Shared D1 besides `JOBS_DB` is unchanged: jobs data does not live on `APP_DB`.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not pause job writes, export `APP_DB`, or apply a jobs-table drop by hand.

When jobs sources change, the workflow deploys `kody-jobs` before origin so the
`JOBS` binding validates. That order is binding hygiene. It does not re-apply
the `v1` transfer and it does not copy rows.

UI/blog-only uploads skip jobs.

Verify cron ticks (jobs-worker logs show `scheduled` invocations every 5 minutes
and queue consumption on `kody-scheduled-dispatch`), a due job running
end-to-end (`JobManager` alarm → `HOST.runDueJobsForUser` → a run in the user's
activity), and dashboards (`/@<slug>/-/jobs`) plus MCP `jobs_*` listing
`JOBS_DB` rows.

# kody jobs worker

The jobs and scheduled lane extracted from the origin `kody` Worker per
[ADR 0016](../../docs/contributing/decisions/0016-mono-worker-extraction.md):
`JobManager`, the dedicated `JOBS_DB` D1 database, the five-minute cron trigger,
and the `kody-scheduled-dispatch` queue.

The Worker entry module is
[`packages/jobs-worker/src/index.ts`](./src/index.ts). Cron and queue dispatch
call back into origin `JobsHost` over the `HOST` service binding, except
`job_schedule_watchdog`: that lane runs locally every 15 minutes
(`runJobScheduleWatchdogTick`), scans silently overdue and stuck-skipped jobs on
`JOBS_DB`, repairs stuck occurrence fences, and best-effort re-arms each
affected user's `JobManager` alarm (at most 50 users per tick; individual syncs
may fail; scans may be truncated). There is no public hostname; health is
`GET /health` on the workers.dev URL the deploy workflow records.

- `wrangler.jsonc` — the committed base config (script name `kody-jobs`).
  Deployable configs are written by
  [`tools/ci/jobs-worker-resources.ts`](../../tools/ci/jobs-worker-resources.ts).
  Local `npm run dev` writes a gitignored `wrangler-local-dev.generated.json`
  that pins the registered name to `kody-jobs` so origin `JOBS` resolves under
  `--env production`.
- Build check: `npm run jobs:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
- Production Durable Object and `JOBS_DB` ownership: see the
  [migration runbook](../../docs/contributing/architecture/jobs-worker-migration-runbook.md).

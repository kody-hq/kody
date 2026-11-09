import type { JobsHostContract } from '@kody-internal/shared/jobs/rpc.ts'

/**
 * Bindings for the jobs worker (see wrangler.jsonc). Kept hand-written like
 * the status worker: the surface is small enough that generated types are not
 * worth a second `wrangler types` pipeline.
 */
export type JobsWorkerEnv = {
	JOBS_DB: D1Database
	JOB_MANAGER: DurableObjectNamespace
	/** Main worker's `JobsHost` entrypoint. */
	HOST: Fetcher & JobsHostContract
	/** Absent outside production: dispatch falls back to direct execution. */
	SCHEDULED_DISPATCH_QUEUE?: Queue
	SENTRY_DSN?: string
	SENTRY_ENVIRONMENT?: string
	SENTRY_TRACES_SAMPLE_RATE?: number
	APP_COMMIT_SHA?: string
}

import type { JobsServiceContract } from '@kody-internal/shared/jobs/rpc.ts'
import {
	createD1JobsStore,
	type JobsStore,
} from '@kody-internal/shared/jobs/store.ts'

/** The bindings {@link jobsData} needs; narrower than the full worker Env. */
export type JobsDataEnv = Pick<Env, 'JOBS' | 'APP_DB'>

/**
 * The jobs worker's `JobsService` entrypoint, reached through the JOBS
 * service binding (ADR 0016). Wrangler types the binding as a plain
 * `Fetcher`; the RPC surface is pinned by {@link JobsServiceContract}, which
 * `JobsService` in `packages/jobs-worker` implements.
 */
export function jobsService(env: JobsDataEnv): JobsServiceContract | null {
	const jobs = env.JOBS
	if (!jobs) return null
	return jobs as unknown as JobsServiceContract
}

/**
 * Jobs-data access for the main worker. In deployed environments the JOBS
 * service binding reaches the jobs worker, which owns the `jobs` table in
 * the dedicated jobs D1 database. In tests (and local setups without the
 * jobs worker running) the binding is absent and jobs data falls back to
 * the same table in APP_DB (created by test fixtures; the production APP_DB
 * copy was dropped after the migration).
 */
export function jobsData(env: JobsDataEnv): JobsStore {
	return jobsService(env) ?? createD1JobsStore(env.APP_DB)
}

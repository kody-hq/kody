import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	createD1JobsStore,
	type JobsStore,
} from '../packages/shared/src/jobs/store.ts'
// Bundled as text by tools/build-test-services.ts (esbuild `.sql` loader).
import jobsInitSql from '../packages/jobs-worker/migrations/0001-jobs-init.sql'
import jobsSoftDeleteSql from '../packages/jobs-worker/migrations/0002-teams-expand-actor-and-soft-delete.sql'
import jobsEnabledBeforeSoftDeleteSql from '../packages/jobs-worker/migrations/0003-job-enabled-before-soft-delete.sql'
import jobsDropPreservedSql from '../packages/jobs-worker/migrations/0005-drop-preserved-and-archived-artifacts.sql'

/**
 * Auxiliary worker for the workers-unit vitest pool: the main worker's test
 * env binds JOBS to "kody-jobs-test" (ADR 0016), which local `wrangler dev`
 * resolves from the real jobs-worker config. The vitest pool only loads the
 * main worker config, so this bundle serves the JobsService contract from the
 * shared D1 jobs store against its own JOBS_DB (schema applied lazily from
 * the real jobs-worker migration).
 */

type StubEnv = { JOBS_DB: D1Database }

function migrationStatements(sql: string) {
	return sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0)
}

const schemaStatements = [
	// 0005 drops `jobs.preserved` and this index. Re-applying 0001 cannot
	// recreate the index once the column is gone, and tests do not query it.
	...migrationStatements(jobsInitSql).filter(
		(statement) => !/idx_jobs_retention_candidates/i.test(statement),
	),
	...migrationStatements(jobsSoftDeleteSql),
	...migrationStatements(jobsEnabledBeforeSoftDeleteSql),
	...migrationStatements(jobsDropPreservedSql),
]

// Runs on every call (not memoized): the pool's isolated storage can reset
// the aux worker's D1 between tests while module state survives.
async function ensureSchema(db: D1Database) {
	for (const statement of schemaStatements) {
		try {
			await db.prepare(statement).run()
		} catch (error) {
			const message = String(error)
			// 0005 drops `jobs.preserved` on every call. SQLite has no
			// DROP COLUMN IF EXISTS, so the repeat is "no such column".
			// Do not swallow that error from earlier statements (0002
			// updates archived columns); a missing column there is drift.
			const repeatedColumnDrop =
				message.includes('no such column') &&
				/^alter\s+table\s+\w+\s+drop\s+column\b/i.test(statement)
			if (
				message.includes('already exists') ||
				message.includes('duplicate column name') ||
				repeatedColumnDrop
			) {
				continue
			}
			throw error
		}
	}
}

const storeMethodNames = [
	'insertJob',
	'updateJob',
	'getJobById',
	'listJobsForUser',
	'listJobsPage',
	'listDueJobs',
	'getNextRunnableJob',
	'claimJob',
	'finalizeClaimedJob',
	'retryClaimedJob',
	'refreshPackageJobIdentity',
	'deleteJob',
	'disableExpiredJobsForUser',
	'countJobsForUser',
	'countJobsBySourceId',
	'sumJobsStorageBytesForUser',
	'listJobStorageIdsForUser',
	'listAllJobStorageOwners',
	'getJobInsights',
	'purgeUserJobsData',
] satisfies Array<keyof JobsStore>

class JobsService extends WorkerEntrypoint<StubEnv> {
	async syncAlarm(_input: { userId: string }) {}

	async purgeUser(input: { userId: string }) {
		await ensureSchema(this.env.JOBS_DB)
		await createD1JobsStore(this.env.JOBS_DB).purgeUserJobsData(input)
		return { ok: true as const, userId: input.userId, purged: true }
	}
}

for (const name of storeMethodNames) {
	Object.defineProperty(JobsService.prototype, name, {
		value: async function (this: JobsService, input: never) {
			const env = (this as unknown as { env: StubEnv }).env
			await ensureSchema(env.JOBS_DB)
			const store = createD1JobsStore(env.JOBS_DB)
			return await (store[name] as (input: never) => Promise<unknown>)(input)
		},
		writable: true,
		configurable: true,
	})
}

export { JobsService }

export default {
	fetch() {
		return new Response('jobs test service', { status: 404 })
	},
}

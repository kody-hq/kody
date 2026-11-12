import { runD1WithRetry } from '@kody-internal/shared/d1-retry.ts'

/**
 * Liveness and JOBS_DB checks for the jobs worker. The public status page
 * probes these over a service binding (no public jobs hostname). JOBS_DB
 * rides on the same Jobs component — there is no separate storage card.
 */

const componentCheckTimeoutMs = 5_000
const d1CheckRetryOptions = {
	maxAttempts: 3,
	attemptTimeoutMs: 900,
} as const
const noStoreHeaders = { 'Cache-Control': 'no-store' } as const

type JobsHealthComponentId = 'jobs_db'

type JobsHealthComponentResult = {
	id: JobsHealthComponentId
	ok: boolean
	latencyMs: number
	error?: 'timeout' | 'unavailable' | 'error'
}

export type JobsHealthComponentsReport = {
	ok: boolean
	commit: string | null
	checkedAt: string
	components: Array<JobsHealthComponentResult>
}

type JobsHealthEnv = {
	JOBS_DB?: D1Database
	APP_COMMIT_SHA?: string
}

async function checkJobsDb(
	db: D1Database | undefined,
): Promise<JobsHealthComponentResult> {
	const startedAt = Date.now()
	if (!db) {
		return { id: 'jobs_db', ok: false, latencyMs: 0, error: 'unavailable' }
	}
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'timeout'>((resolve) => {
		timeoutHandle = setTimeout(
			() => resolve('timeout'),
			componentCheckTimeoutMs,
		)
	})
	try {
		const outcome = await Promise.race([
			runD1WithRetry(
				() => db.prepare('SELECT 1').first(),
				d1CheckRetryOptions,
			).then(() => 'ok' as const),
			timeout,
		])
		const latencyMs = Date.now() - startedAt
		if (outcome === 'timeout') {
			console.warn(
				'jobs-health-component-timeout',
				JSON.stringify({ id: 'jobs_db' }),
			)
			return { id: 'jobs_db', ok: false, latencyMs, error: 'timeout' }
		}
		return { id: 'jobs_db', ok: true, latencyMs }
	} catch (error) {
		const latencyMs = Date.now() - startedAt
		console.warn(
			'jobs-health-component-failed',
			JSON.stringify({
				id: 'jobs_db',
				message: error instanceof Error ? error.message : String(error),
			}),
		)
		return { id: 'jobs_db', ok: false, latencyMs, error: 'error' }
	} finally {
		clearTimeout(timeoutHandle)
	}
}

export async function collectJobsHealthComponents(
	env: JobsHealthEnv,
): Promise<JobsHealthComponentsReport> {
	const jobsDb = await checkJobsDb(env.JOBS_DB)
	return {
		ok: jobsDb.ok,
		commit: env.APP_COMMIT_SHA ?? null,
		checkedAt: new Date().toISOString(),
		components: [jobsDb],
	}
}

export async function handleJobsHealthRequest(
	request: Request,
	env: JobsHealthEnv,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		return Response.json(
			{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
			{ headers: noStoreHeaders },
		)
	}
	if (url.pathname === '/health/components') {
		const report = await collectJobsHealthComponents(env)
		return Response.json(report, {
			status: report.ok ? 200 : 503,
			headers: noStoreHeaders,
		})
	}
	return null
}

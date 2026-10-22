import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent } from '@sentry/core'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'
import { type JobsWorkerEnv } from './env.ts'

export function filterRetryableD1LockSentryEvent(event: ErrorEvent) {
	if (!isRetryableD1LockSentryEvent(event)) return event
	return null
}

export function filterJobsWorkerSentryEvent(event: ErrorEvent) {
	if (filterRetryableD1LockSentryEvent(event) === null) return null
	return event
}

/**
 * Same test-env DSN suppression as the origin worker: wrangler `env.test`
 * must never ingest even when a local `.env` supplies a real DSN.
 */
export function resolveJobsWorkerSentryDsn(env: {
	SENTRY_DSN?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
}): string | undefined {
	if (env.SENTRY_ENVIRONMENT?.trim() === 'test') return undefined
	const dsn = env.SENTRY_DSN?.trim()
	return dsn || undefined
}

export function buildSentryOptions(env: JobsWorkerEnv): CloudflareOptions {
	const dsn = resolveJobsWorkerSentryDsn(env)
	const environment = env.SENTRY_ENVIRONMENT?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()
	const tracesSampleRate =
		typeof env.SENTRY_TRACES_SAMPLE_RATE === 'number'
			? env.SENTRY_TRACES_SAMPLE_RATE
			: 1.0
	return {
		...(dsn ? { dsn } : {}),
		environment,
		...(release ? { release } : {}),
		tracesSampleRate,
		sendDefaultPii: false,
		// Bare D1 platform blips (SQLITE_BUSY, long-running export, network
		// lost, DB overloaded, internal error with reference) are dropped —
		// same class as the main worker. JobManager DO alarms rethrow after
		// HOST.runDueJobsForUser fails during a DR export; without this filter
		// those open Sentry issues (KODY-9D).
		beforeSend: filterJobsWorkerSentryEvent,
	}
}

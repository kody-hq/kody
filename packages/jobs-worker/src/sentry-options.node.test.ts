import { expect, test } from 'vitest'
import { type JobsWorkerEnv } from './env.ts'
import {
	buildSentryOptions,
	resolveJobsWorkerSentryDsn,
} from './sentry-options.ts'

test('test-env config with a DSN present still yields no Sentry DSN', () => {
	const testEnvDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0'
	const testEnv = {
		SENTRY_DSN: testEnvDsn,
		SENTRY_ENVIRONMENT: 'test',
	} as JobsWorkerEnv

	expect(resolveJobsWorkerSentryDsn(testEnv)).toBeUndefined()
	expect(buildSentryOptions(testEnv).dsn).toBeUndefined()

	const productionEnv = {
		SENTRY_DSN: testEnvDsn,
		SENTRY_ENVIRONMENT: 'production',
	} as JobsWorkerEnv
	expect(resolveJobsWorkerSentryDsn(productionEnv)).toBe(testEnvDsn)
	expect(buildSentryOptions(productionEnv).dsn).toBe(testEnvDsn)
})

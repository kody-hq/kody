import type { ErrorEvent } from '@sentry/core'
import { expect, test } from 'vitest'
import {
	buildSentryOptions,
	filterSentryEvent,
	getWorkerSentryOptions,
	resolveWorkerSentryDsn,
} from './sentry-options.ts'

test('filterSentryEvent redacts Kody credentials from event messages', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrapCode = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
	const event: ErrorEvent = {
		type: undefined,
		message: `request failed with ${apiToken}`,
		logentry: { message: `bootstrap ${bootstrapCode}` },
		exception: {
			values: [
				{
					type: 'Error',
					value: `credentials ${apiToken} and ${bootstrapCode}`,
				},
			],
		},
	}

	expect(filterSentryEvent(event)).toBe(event)
	expect(event.message).toBe('request failed with kody_at_[redacted]')
	expect(event.logentry?.message).toBe('bootstrap kody_bc_[redacted]')
	expect(event.exception?.values?.[0]?.value).toBe(
		'credentials kody_at_[redacted] and kody_bc_[redacted]',
	)
})

test('test-env config with a DSN present still yields no Sentry options', () => {
	// Local packages/worker/.env may inject a real DSN into wrangler env=test;
	// automated runs must never initialize ingest (KODY-AG / KODY-AF).
	const testEnvDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0'
	const testEnv = {
		SENTRY_DSN: testEnvDsn,
		SENTRY_ENVIRONMENT: 'test',
	} as Env

	expect(resolveWorkerSentryDsn(testEnv)).toBeUndefined()
	expect(buildSentryOptions(testEnv).dsn).toBeUndefined()
	expect(getWorkerSentryOptions(testEnv)).toBeUndefined()

	const productionEnv = {
		SENTRY_DSN: testEnvDsn,
		SENTRY_ENVIRONMENT: 'production',
	} as Env
	expect(resolveWorkerSentryDsn(productionEnv)).toBe(testEnvDsn)
	expect(getWorkerSentryOptions(productionEnv)?.dsn).toBe(testEnvDsn)
})

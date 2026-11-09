import { expect, test } from 'vitest'
import {
	classifyRetryableD1Error,
	isBareRetryableD1LockSentryEvent,
	readD1RetryAttempts,
	runD1WithRetry,
	isBrowserRetryableD1LockSentryEvent,
	transientDatabaseUnavailableMessage,
} from './d1-retry.ts'

function exceptionEvent(...values: Array<string>) {
	return {
		exception: {
			values: values.map((value) => ({ type: 'Error', value })),
		},
	}
}

test('isBareRetryableD1LockSentryEvent drops bare export locks and keeps wrappers', () => {
	expect(
		isBareRetryableD1LockSentryEvent(
			exceptionEvent('D1_ERROR: Currently processing a long-running export.'),
		),
	).toBe(true)
	expect(
		isBareRetryableD1LockSentryEvent(
			exceptionEvent(transientDatabaseUnavailableMessage),
		),
	).toBe(false)
	expect(
		isBareRetryableD1LockSentryEvent(
			exceptionEvent(
				'serveMcp could not recover after retries',
				'D1_ERROR: Currently processing a long-running export.',
			),
		),
	).toBe(false)
})

test('isBrowserRetryableD1LockSentryEvent also drops remapped storage-unavailable messages', () => {
	expect(
		isBrowserRetryableD1LockSentryEvent(
			exceptionEvent('D1_ERROR: Currently processing a long-running export.'),
		),
	).toBe(true)
	expect(
		isBrowserRetryableD1LockSentryEvent(
			exceptionEvent(transientDatabaseUnavailableMessage),
		),
	).toBe(true)
	expect(
		isBrowserRetryableD1LockSentryEvent(
			exceptionEvent(`Error: ${transientDatabaseUnavailableMessage}`),
		),
	).toBe(true)
	expect(
		isBrowserRetryableD1LockSentryEvent(
			exceptionEvent(
				transientDatabaseUnavailableMessage,
				'D1_ERROR: Currently processing a long-running export.',
			),
		),
	).toBe(true)
	expect(
		isBrowserRetryableD1LockSentryEvent(
			exceptionEvent(
				'Package page failed',
				transientDatabaseUnavailableMessage,
			),
		),
	).toBe(false)
})

test('classifyRetryableD1Error names the D1 kind and ignores query mistakes', () => {
	expect(
		classifyRetryableD1Error(
			new Error('wrapped', {
				cause: new Error(
					'D1_ERROR: Currently processing a long-running export',
				),
			}),
		),
	).toBe('export')
	expect(classifyRetryableD1Error(new Error('D1_ERROR: SQLITE_BUSY'))).toBe(
		'lock',
	)
	expect(
		classifyRetryableD1Error(new Error('internal error; reference = abc123')),
	).toBe('internal')
	expect(
		classifyRetryableD1Error(
			new Error('Durable Object reset because its code was updated.'),
		),
	).toBe('do_reset')
	expect(
		classifyRetryableD1Error(
			new Error(
				'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.',
			),
		),
	).toBe('overloaded')
	expect(
		classifyRetryableD1Error(
			new Error('D1_ERROR: no such table: missing: SQLITE_ERROR'),
		),
	).toBeNull()
})

test('readD1RetryAttempts reports how many tries runD1WithRetry made', async () => {
	const busy = new Error('D1_ERROR: SQLITE_BUSY')
	const thrown = await runD1WithRetry(
		async () => {
			throw busy
		},
		{ maxAttempts: 3, baseDelayMs: 0 },
	).catch((error: unknown) => error)
	expect(thrown).toBe(busy)
	expect(readD1RetryAttempts(new Error('outer', { cause: busy }))).toBe(3)

	const badSql = new Error('D1_ERROR: near "SELEC": syntax error')
	await runD1WithRetry(async () => {
		throw badSql
	}).catch(() => undefined)
	expect(readD1RetryAttempts(badSql)).toBeNull()
})

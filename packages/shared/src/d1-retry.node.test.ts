import { expect, test } from 'vitest'
import {
	isBareRetryableD1LockSentryEvent,
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

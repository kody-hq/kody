import type { ErrorEvent } from '@sentry/core'
import { expect, test } from 'vitest'
import {
	isBareRetryableD1LockMessage,
	isRetryableD1LockSentryEvent,
} from './d1-retry.ts'
import {
	filterJobsWorkerSentryEvent,
	filterRetryableD1LockSentryEvent,
} from './sentry-options.ts'

const d1SqliteBusy = 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'
const d1LongRunningExport =
	'D1_ERROR: Currently processing a long-running export.'
const d1StartupReset =
	'Internal error while starting up Durable Object storage caused object to be reset; reference = abc123'

function rebuildFailureWrapper(causeMessage: string) {
	return `Package source publish succeeded, but bundle artifact rebuild failed for source "source-1" at commit "commit-1". Succeeded: none. Failed: { kind "app", artifact "<default>", entry "index.ts", bundle "app" }: ${causeMessage}. Re-run the publish capability to repair artifacts.`
}

function exceptionEvent(...values: Array<string>): ErrorEvent {
	return {
		type: undefined,
		exception: {
			values: values.map((value) => ({ value })),
		},
	}
}

test('isRetryableD1LockSentryEvent drops bare D1 blips and keeps recovery wrappers', () => {
	expect(isRetryableD1LockSentryEvent(exceptionEvent(d1SqliteBusy))).toBe(true)
	expect(isRetryableD1LockSentryEvent(exceptionEvent(d1StartupReset))).toBe(
		true,
	)
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(
				'Currently processing a long-running export.',
				d1LongRunningExport,
			),
		),
	).toBe(true)
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(
				'artifact rebuild failed after partial writes',
				d1StartupReset,
			),
		),
	).toBe(false)
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(rebuildFailureWrapper(d1SqliteBusy), d1SqliteBusy),
		),
	).toBe(false)
	expect(
		isRetryableD1LockSentryEvent({
			type: undefined,
			message: d1LongRunningExport,
		}),
	).toBe(true)
	expect(
		isRetryableD1LockSentryEvent({
			type: undefined,
			message: rebuildFailureWrapper(d1SqliteBusy),
			exception: { values: [{ value: d1SqliteBusy }] },
		}),
	).toBe(false)
})

test('jobs-worker beforeSend drops bare long-running export and keeps wrappers', () => {
	expect(
		isBareRetryableD1LockMessage(
			'D1_ERROR: Currently processing a long-running export.',
		),
	).toBe(true)
	expect(
		filterRetryableD1LockSentryEvent(exceptionEvent(d1LongRunningExport)),
	).toBe(null)
	expect(filterJobsWorkerSentryEvent(exceptionEvent(d1LongRunningExport))).toBe(
		null,
	)
	expect(
		filterJobsWorkerSentryEvent(
			exceptionEvent(rebuildFailureWrapper(d1LongRunningExport)),
		),
	).toEqual(exceptionEvent(rebuildFailureWrapper(d1LongRunningExport)))
})

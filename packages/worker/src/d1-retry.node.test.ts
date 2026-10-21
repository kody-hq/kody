import { type ErrorEvent } from '@sentry/core'
import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	isBareRetryableD1LockMessage,
	isRetryableD1LockError,
	isRetryableD1LockMessage,
	isRetryableD1LockSentryEvent,
	runD1WithRetry,
} from './d1-retry.ts'

const d1SqliteBusy = 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'
const d1StartupReset =
	'Internal error while starting up Durable Object storage caused object to be reset; reference = abc123'

/** Same shape as `buildRebuildFailureMessage` when a target fails with a D1 blip. */
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

// KODY-81: live Cloudflare `reference =` tokens include `_`.
const underscoredD1InternalErrorReference =
	'e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39'

test('runD1WithRetry matches lock errors, retries them, and rethrows other failures immediately', async () => {
	const internalErrorRef = `D1_ERROR: internal error; reference = ${underscoredD1InternalErrorReference}`
	const doReset =
		'D1_ERROR: Internal error in Durable Object storage caused object to be reset'
	// [message, retryable, check via Error (true) or raw message (false)]
	const cases: Array<[string, boolean, boolean]> = [
		['D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY', true, true],
		['Currently processing a long-running export.', true, true],
		['Network connection lost.', true, true],
		[
			'D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
			true,
			true,
		],
		['D1 DB is overloaded. Requests queued for too long', true, true],
		['D1_ERROR: D1 DB is overloaded. Too many requests queued.', true, true],
		['D1 DB is overloaded. Too many requests queued', true, true],
		[
			'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
			true,
			true,
		],
		[internalErrorRef, true, false],
		[`Error: ${internalErrorRef}`, true, false],
		[internalErrorRef, true, true],
		[
			'D1_ERROR: internal error; reference = e-Gz3hrU-5c47162d21d24e238a5c25e98b89ee39',
			true,
			false,
		],
		[
			'Internal error in D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
			true,
			true,
		],
		[
			'Internal error in D1 DB storage caused object to be reset; reference = 8t4d_qqpo-q1ctvjr8kca8fl4c',
			true,
			false,
		],
		// KODY-82: D1 can surface DO-storage object-reset under D1_ERROR:.
		[`${doReset}; reference = b44vvje0qcq0ubd9ea522366`, true, false],
		[`Error: ${doReset}; reference = b44vvje0qcq0ubd9ea522366`, true, true],
		// KODY-95: startup phrasing of the same DO-storage-reset family.
		[
			'Internal error while starting up Durable Object storage caused object to be reset; reference = 9k2mnpq7rstuvwxyzabcdefg',
			true,
			false,
		],
		[
			'Error: Internal error while starting up Durable Object storage caused object to be reset; reference = e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39',
			true,
			true,
		],
		[
			'D1_ERROR: Internal error while starting up Durable Object storage caused object to be reset; reference = b44vvje0qcq0ubd9ea522366',
			true,
			false,
		],
		[
			'Error: D1_ERROR: Internal error while starting up Durable Object storage caused object to be reset; reference = b44vvje0qcq0ubd9ea522366',
			true,
			true,
		],
		[
			'Internal error while starting up D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
			true,
			false,
		],
		// KODY-A9: D1 can surface DO isolate platform-resets under D1_ERROR:.
		[
			'D1_ERROR: Durable Object reset because its code was updated.',
			true,
			true,
		],
		[
			'Error: D1_ERROR: Durable Object reset because its code was updated.',
			true,
			false,
		],
		['Durable Object reset because its code was updated', true, false],
		[
			'D1_ERROR: Durable Object storage operation exceeded timeout which caused object to be reset.',
			true,
			true,
		],
		[
			'D1_ERROR: Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
			true,
			false,
		],
		['Network connection lost while uploading...', false, true],
		['queue is overloaded while uploading...', false, true],
		['internal error', false, false],
		['internal error', false, true],
		[
			'Error: D1_ERROR: internal error while writing mcp_agent_sessions',
			false,
			false,
		],
		[
			'D1_ERROR: Internal error in D1 DB storage caused object to be reset',
			false,
			true,
		],
		[doReset, false, false],
		// KODY-95 negatives: no reference, wrapped, unrelated "while …".
		[
			'Internal error while starting up Durable Object storage caused object to be reset',
			false,
			false,
		],
		[
			'D1_ERROR: Internal error while starting up Durable Object storage caused object to be reset',
			false,
			true,
		],
		['Internal error while starting up the package executor', false, false],
		[
			'serveMcp could not recover after retries: Internal error while starting up Durable Object storage caused object to be reset; reference = 9k2mnpq7rstuvwxyzabcdefg',
			false,
			true,
		],
		// KODY-A9: wrappers that embed the code-updated sentence stay non-retryable.
		[
			'serveMcp could not recover after retries: D1_ERROR: Durable Object reset because its code was updated.',
			false,
			true,
		],
		['syntax error near SELECT', false, true],
	]
	expect(
		cases.filter(
			([message, want, asError]) =>
				(asError
					? isRetryableD1LockError(new Error(message))
					: isRetryableD1LockMessage(message)) !== want,
		),
	).toEqual([])

	const successOperation = vi.fn(async () => 'ok')
	await expect(runD1WithRetry(successOperation)).resolves.toBe('ok')
	expect(successOperation).toHaveBeenCalledTimes(1)

	const retryOperation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce('ok')
	vi.useFakeTimers()
	try {
		const resultPromise = runD1WithRetry(retryOperation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(retryOperation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const failingOperation = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near INSERTZ'))
	await expect(runD1WithRetry(failingOperation)).rejects.toThrow('syntax error')
	expect(failingOperation).toHaveBeenCalledTimes(1)
})

test('runD1WithRetry retries hung attempts when attemptTimeoutMs is set', async () => {
	let attempts = 0
	const hungThenOk = vi.fn(async () => {
		attempts += 1
		if (attempts === 1) {
			await new Promise(() => {})
		}
		return 'ok'
	})
	await expect(
		runD1WithRetry(hungThenOk, {
			maxAttempts: 3,
			attemptTimeoutMs: 20,
			baseDelayMs: 1,
		}),
	).resolves.toBe('ok')
	expect(hungThenOk).toHaveBeenCalledTimes(2)

	const alwaysHung = vi.fn(async () => {
		await new Promise(() => {})
		return 'ok'
	})
	await expect(
		runD1WithRetry(alwaysHung, {
			maxAttempts: 2,
			attemptTimeoutMs: 15,
			baseDelayMs: 1,
		}),
	).rejects.toThrow('D1 attempt timed out after 15ms')
	expect(alwaysHung).toHaveBeenCalledTimes(2)
})

test('isBareRetryableD1LockMessage rejects wrappers that embed lock or export text', () => {
	const d1CodeUpdatedReset =
		'D1_ERROR: Durable Object reset because its code was updated.'
	expect(isBareRetryableD1LockMessage(d1SqliteBusy)).toBe(true)
	expect(isBareRetryableD1LockMessage('D1_ERROR: database is locked')).toBe(
		true,
	)
	expect(
		isBareRetryableD1LockMessage(
			'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_SNAPSHOT)',
		),
	).toBe(true)
	expect(
		isBareRetryableD1LockMessage(
			'D1_ERROR: Currently processing a long-running export.',
		),
	).toBe(true)
	expect(isBareRetryableD1LockMessage(d1StartupReset)).toBe(true)
	// KODY-A9: bare D1-prefixed DO code-updated reset matches; wrappers do not.
	expect(isBareRetryableD1LockMessage(d1CodeUpdatedReset)).toBe(true)
	expect(isBareRetryableD1LockMessage(`Error: ${d1CodeUpdatedReset}`)).toBe(
		true,
	)
	// Substring retry matcher still accepts embedded text; bare Sentry matcher must not.
	const d1SqliteBusyExtended =
		'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_SNAPSHOT)'
	expect(isRetryableD1LockMessage(rebuildFailureWrapper(d1SqliteBusy))).toBe(
		true,
	)
	expect(
		isBareRetryableD1LockMessage(rebuildFailureWrapper(d1SqliteBusy)),
	).toBe(false)
	expect(
		isBareRetryableD1LockMessage(rebuildFailureWrapper(d1SqliteBusyExtended)),
	).toBe(false)
	expect(
		isBareRetryableD1LockMessage(rebuildFailureWrapper(d1StartupReset)),
	).toBe(false)
	expect(
		isBareRetryableD1LockMessage(
			`serveMcp could not recover after retries: ${d1SqliteBusy}`,
		),
	).toBe(false)
	expect(
		isBareRetryableD1LockMessage(
			`serveMcp could not recover after retries: ${d1CodeUpdatedReset}`,
		),
	).toBe(false)
	expect(
		isBareRetryableD1LockMessage(rebuildFailureWrapper(d1CodeUpdatedReset)),
	).toBe(false)
})

test('isRetryableD1LockSentryEvent drops bare D1 blips and keeps recovery wrappers', () => {
	expect(isRetryableD1LockSentryEvent(exceptionEvent(d1SqliteBusy))).toBe(true)
	expect(isRetryableD1LockSentryEvent(exceptionEvent(d1StartupReset))).toBe(
		true,
	)
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(
				'Currently processing a long-running export.',
				'D1_ERROR: Currently processing a long-running export.',
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
			exceptionEvent('serveMcp could not recover after retries', d1SqliteBusy),
		),
	).toBe(false)
	// Real rebuild failure: wrapper embeds the D1 text and attaches it as cause.
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(rebuildFailureWrapper(d1SqliteBusy), d1SqliteBusy),
		),
	).toBe(false)
	expect(
		isRetryableD1LockSentryEvent(
			exceptionEvent(rebuildFailureWrapper(d1StartupReset), d1StartupReset),
		),
	).toBe(false)
	expect(
		isRetryableD1LockSentryEvent({
			type: undefined,
			message: d1StartupReset,
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

import { expect, test, vi } from 'vitest'
import {
	agentsSdkSqlErrorMessagePrefix,
	durableObjectCodeUpdatedResetMessage,
	durableObjectInstanceInactiveCloseMessage,
	durableObjectSqliteOutOfMemoryMessage,
} from '#worker/sentry-options.ts'
import {
	isTransientDurableObjectResetError,
	runWithTransientDurableObjectResetRetry,
} from './durable-object-reset-retry.ts'

function errorField(value: unknown) {
	return typeof value === 'object' &&
		value &&
		'error' in value &&
		typeof value.error === 'string'
		? value.error
		: null
}

async function settle<T>(pending: Promise<T>) {
	await vi.runAllTimersAsync()
	return pending
}

test('transient Durable Object reset retry recovers thrown and result errors then exhausts', async () => {
	const transientCases: Array<[unknown, boolean]> = [
		[new Error(durableObjectCodeUpdatedResetMessage), true],
		// KODY-A9: D1 bindings surface the same code-updated reset under D1_ERROR:.
		[new Error(`D1_ERROR: ${durableObjectCodeUpdatedResetMessage}`), true],
		[
			new Error(
				`Error: D1_ERROR: ${durableObjectCodeUpdatedResetMessage.replace(/\.$/, '')}`,
			),
			true,
		],
		[
			new Error('wrapped', {
				cause: new Error(durableObjectCodeUpdatedResetMessage),
			}),
			true,
		],
		[new Error(durableObjectInstanceInactiveCloseMessage), true],
		[durableObjectSqliteOutOfMemoryMessage.replace(/\.$/, ''), true],
		[new Error(durableObjectSqliteOutOfMemoryMessage), true],
		// KODY-B9: Agents SDK SqlError wraps the bare DO SQLite OOM; treat the
		// wrapper the same as the bare platform string for retry classification.
		[
			`${agentsSdkSqlErrorMessagePrefix} ${durableObjectSqliteOutOfMemoryMessage.replace(/\.$/, '')}`,
			true,
		],
		[
			new Error(
				`${agentsSdkSqlErrorMessagePrefix} ${durableObjectSqliteOutOfMemoryMessage}`,
				{
					cause: new Error(
						durableObjectSqliteOutOfMemoryMessage.replace(/\.$/, ''),
					),
				},
			),
			true,
		],
		[
			new Error(
				`${agentsSdkSqlErrorMessagePrefix} database is locked: SQLITE_BUSY`,
			),
			false,
		],
		[new Error('user code failed'), false],
		[
			new Error(
				`serveMcp could not recover after retries: D1_ERROR: ${durableObjectCodeUpdatedResetMessage}`,
			),
			false,
		],
		[
			new Error(
				`serveMcp could not recover after retries: ${agentsSdkSqlErrorMessagePrefix} ${durableObjectSqliteOutOfMemoryMessage}`,
			),
			false,
		],
	]
	expect(
		transientCases.filter(
			([error, want]) => isTransientDurableObjectResetError(error) !== want,
		),
	).toEqual([])

	vi.useFakeTimers()
	try {
		const thrownThenOk = vi
			.fn<() => Promise<{ ok: boolean }>>()
			.mockRejectedValueOnce(new Error(durableObjectCodeUpdatedResetMessage))
			.mockResolvedValueOnce({ ok: true })
		const retries: Array<{ attempt: number; nextDelayMs: number }> = []
		await expect(
			settle(
				runWithTransientDurableObjectResetRetry({
					operation: thrownThenOk,
					onRetry: ({ attempt, nextDelayMs }) => {
						retries.push({ attempt, nextDelayMs })
					},
				}),
			),
		).resolves.toEqual({ ok: true })
		expect(thrownThenOk).toHaveBeenCalledTimes(2)
		expect(retries).toEqual([{ attempt: 1, nextDelayMs: 100 }])

		const resultThenOk = vi
			.fn<() => Promise<{ error?: string; result?: string }>>()
			.mockResolvedValueOnce({ error: durableObjectCodeUpdatedResetMessage })
			.mockResolvedValueOnce({ result: 'recovered' })
		await expect(
			settle(
				runWithTransientDurableObjectResetRetry({
					operation: resultThenOk,
					retryableResultError: errorField,
				}),
			),
		).resolves.toEqual({ result: 'recovered' })
		expect(resultThenOk).toHaveBeenCalledTimes(2)

		const permanent = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error('user code failed'))
		await expect(
			runWithTransientDurableObjectResetRetry({ operation: permanent }),
		).rejects.toThrow('user code failed')
		expect(permanent).toHaveBeenCalledTimes(1)

		const exhausted = vi
			.fn<() => Promise<{ error: string }>>()
			.mockResolvedValue({ error: durableObjectCodeUpdatedResetMessage })
		await expect(
			settle(
				runWithTransientDurableObjectResetRetry({
					operation: exhausted,
					retryableResultError: errorField,
				}),
			),
		).resolves.toEqual({ error: durableObjectCodeUpdatedResetMessage })
		expect(exhausted).toHaveBeenCalledTimes(4)

		const dirtyResult = vi
			.fn<() => Promise<{ error: string; dirty: boolean }>>()
			.mockResolvedValue({
				error: durableObjectCodeUpdatedResetMessage,
				dirty: true,
			})
		await expect(
			runWithTransientDurableObjectResetRetry({
				operation: dirtyResult,
				retryableResultError: (value) => value.error,
				shouldRetry: ({ result }) => result?.dirty !== true,
			}),
		).resolves.toEqual({
			error: durableObjectCodeUpdatedResetMessage,
			dirty: true,
		})
		expect(dirtyResult).toHaveBeenCalledTimes(1)

		const dirtyThrown = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error(durableObjectCodeUpdatedResetMessage))
		await expect(
			runWithTransientDurableObjectResetRetry({
				operation: dirtyThrown,
				shouldRetry: () => false,
			}),
		).rejects.toThrow(durableObjectCodeUpdatedResetMessage)
		expect(dirtyThrown).toHaveBeenCalledTimes(1)

		const exhaustedUndefined = vi
			.fn<() => Promise<undefined>>()
			.mockResolvedValue(undefined)
		await expect(
			settle(
				runWithTransientDurableObjectResetRetry({
					operation: exhaustedUndefined,
					retryableResultError: () => durableObjectCodeUpdatedResetMessage,
				}),
			),
		).resolves.toBeUndefined()
		expect(exhaustedUndefined).toHaveBeenCalledTimes(4)
	} finally {
		vi.useRealTimers()
	}
})

import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import {
	isDurableObjectIsolateResetMessage,
	isDurableObjectIsolateResourceLimitResetMessage,
} from '#worker/sentry-options.ts'

/**
 * Bounded backoff for sandbox execution. The final delay gives deploy drains
 * time to finish before the last attempt reaches a fresh isolate.
 */
export const durableObjectResetRetryDelaysMs = [100, 500, 1_500] as const

/**
 * Memory/CPU isolate resets and DO SQLite SQLITE_NOMEM. Deterministic for the
 * same work on a fresh isolate — callers should fail closed with an
 * actionable message instead of burning the transient-reset retry budget.
 */
export function isDurableObjectIsolateResourceLimitResetError(error: unknown) {
	if (typeof error === 'string') {
		return isDurableObjectIsolateResourceLimitResetMessage(error)
	}
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

/**
 * Platform resets that are safe to retry on a fresh isolate: deploy
 * "code was updated", storage timeouts/faults, blockConcurrencyWhile, and
 * inactive-instance closes. Excludes memory/CPU / SQLITE_NOMEM resource
 * limits — those repeat for the same package tip.
 */
export function isTransientDurableObjectResetError(error: unknown) {
	if (isDurableObjectIsolateResourceLimitResetError(error)) {
		return false
	}
	if (typeof error === 'string') {
		return isDurableObjectIsolateResetMessage(error)
	}
	return errorCauseChainIncludes(error, isDurableObjectIsolateResetMessage)
}

function assertNotAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new DOMException('The operation was aborted.', 'AbortError')
	}
}

async function delay(ms: number, signal?: AbortSignal) {
	assertNotAborted(signal)
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms))
		return
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(new DOMException('The operation was aborted.', 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

/**
 * Retry an operation when Cloudflare resets a Durable Object isolate
 * (deploy "code was updated", memory/CPU, storage timeout, etc.).
 *
 * Thrown resets retry until the delay list is exhausted, then rethrow.
 * Resolved values can opt in via `retryableResultError` (sandbox execute
 * returns the platform string on `result.error` instead of throwing).
 * Exhausted result-errors return the last value so callers can record it.
 */
export async function runWithTransientDurableObjectResetRetry<T>(input: {
	operation: () => Promise<T>
	retryableResultError?: (result: T) => unknown | null
	/**
	 * Extra gate after a reset is recognized. Return false to keep the
	 * result or rethrow instead of retrying (for example, this evaluate
	 * already started a host-mediated side effect). Omitted means retry.
	 */
	shouldRetry?: (input: { error: unknown; result?: T }) => boolean
	onRetry?: (input: {
		attempt: number
		nextDelayMs: number
		error: unknown
	}) => void
	signal?: AbortSignal
}): Promise<T> {
	const delays = durableObjectResetRetryDelaysMs
	const maxAttempts = delays.length + 1
	let lastResult: T | undefined
	let hasLastResult = false
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		assertNotAborted(input.signal)
		try {
			const result = await input.operation()
			lastResult = result
			hasLastResult = true
			const resultError = input.retryableResultError?.(result) ?? null
			if (
				resultError == null ||
				!isTransientDurableObjectResetError(resultError) ||
				input.shouldRetry?.({ error: resultError, result }) === false
			) {
				return result
			}
			lastError = resultError
		} catch (error) {
			lastError = error
			if (
				!isTransientDurableObjectResetError(error) ||
				attempt === maxAttempts ||
				input.shouldRetry?.({ error }) === false
			) {
				throw error
			}
		}
		if (attempt === maxAttempts) {
			break
		}
		const nextDelayMs = delays[attempt - 1] ?? 0
		input.onRetry?.({
			attempt,
			nextDelayMs,
			error: lastError,
		})
		await delay(nextDelayMs, input.signal)
	}
	if (hasLastResult) {
		return lastResult as T
	}
	throw lastError instanceof Error
		? lastError
		: new Error(getErrorMessage(lastError))
}

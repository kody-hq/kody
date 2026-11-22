import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

/**
 * Bounded retry for transient D1 and R2 errors on a request path. Each call
 * retries up to `transientRetryBackoffMs.length` times with that backoff, and
 * every call in one request draws its backoff from one shared budget, so a
 * request that keeps hitting transient errors fails fast with a typed
 * `TransientRetryBudgetExhaustedError` instead of stacking delays. Wrap the
 * `withDeadline` call, so each attempt gets its own deadline.
 */

/** Message fragments of a transient storage error; anything else is permanent. */
export const transientStorageErrorMarkers = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'D1_ERROR: internal error',
	// R2 internal error.
	'(10001)',
] as const

/** Backoff before retry 1, 2 and 3 of one call (no jitter). */
export const transientRetryBackoffMs = [50, 100, 200] as const

/** Total backoff across every call in one request. */
export const transientRetryBudgetMs = 400

export type RetrySleep = (ms: number) => Promise<void>

const systemRetrySleep: RetrySleep = (ms) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

export type TransientRetryBudget = {
	remainingMs: number
	sleep: RetrySleep
}

/** One budget per request: create it at the request edge and pass it down. */
export function createTransientRetryBudget(
	sleep: RetrySleep = systemRetrySleep,
): TransientRetryBudget {
	return { remainingMs: transientRetryBudgetMs, sleep }
}

export function isTransientStorageError(error: unknown) {
	const message = getErrorMessage(error)
	return transientStorageErrorMarkers.some((marker) => message.includes(marker))
}

export class TransientRetryBudgetExhaustedError extends Error {
	readonly kind = 'transient_retry_budget_exhausted'
	readonly label: string
	constructor(label: string, cause: unknown) {
		super(
			`${label} kept failing with a transient storage error and the request's retry budget is spent: ${getErrorMessage(cause)}`,
			{ cause },
		)
		this.name = 'TransientRetryBudgetExhaustedError'
		this.label = label
	}
}

export function isTransientRetryBudgetExhaustedError(
	error: unknown,
): error is TransientRetryBudgetExhaustedError {
	return error instanceof TransientRetryBudgetExhaustedError
}

/**
 * Runs `call`, retrying transient errors while the request budget allows.
 * Without a budget the call runs once, as before. A permanent error, or a
 * transient one after the last retry, is rethrown unchanged.
 */
export async function withTransientRetry<T>(
	retry: { label: string; budget?: TransientRetryBudget },
	call: () => Promise<T>,
): Promise<T> {
	const { budget } = retry
	if (!budget) return await call()
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await call()
		} catch (error) {
			const backoffMs = transientRetryBackoffMs[attempt]
			if (backoffMs === undefined || !isTransientStorageError(error)) {
				throw error
			}
			if (backoffMs > budget.remainingMs) {
				throw new TransientRetryBudgetExhaustedError(retry.label, error)
			}
			budget.remainingMs -= backoffMs
			await budget.sleep(backoffMs)
		}
	}
}

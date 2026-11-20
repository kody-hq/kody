import { type Clock, sleep } from './clock.ts'

export type RetryPolicy = {
	maxAttempts: number
	baseDelayMs: number
	/** `half` draws the delay uniformly from [backoff/2, backoff). */
	jitter: (error: unknown) => 'none' | 'half'
	isRetryable: (error: unknown) => boolean
}

export type RetryResult<T> =
	| { ok: true; value: T; attempts: number }
	| { ok: false; error: unknown; attempts: number; retryable: boolean }

/**
 * The one retry loop for the retention tick. Exponential backoff
 * (`baseDelayMs * 2^(attempt-1)`) on the injected clock, stops early when the
 * signal aborts, and returns a typed result instead of throwing so callers
 * map exhaustion into their own failure variant.
 */
export async function retry<T>(input: {
	policy: RetryPolicy
	clock: Clock
	signal?: AbortSignal
	random?: () => number
	attempt: (attempt: number) => Promise<T>
}): Promise<RetryResult<T>> {
	const { policy } = input
	const random = input.random ?? Math.random
	for (let attempt = 1; ; attempt++) {
		try {
			return {
				ok: true,
				value: await input.attempt(attempt),
				attempts: attempt,
			}
		} catch (error) {
			const retryable = policy.isRetryable(error)
			if (
				!retryable ||
				attempt >= policy.maxAttempts ||
				input.signal?.aborted
			) {
				return { ok: false, error, attempts: attempt, retryable }
			}
			const backoffMs = policy.baseDelayMs * 2 ** (attempt - 1)
			const delayMs =
				policy.jitter(error) === 'half'
					? backoffMs / 2 + random() * (backoffMs / 2)
					: backoffMs
			try {
				await sleep(input.clock, delayMs, input.signal)
			} catch {
				return { ok: false, error, attempts: attempt, retryable }
			}
		}
	}
}

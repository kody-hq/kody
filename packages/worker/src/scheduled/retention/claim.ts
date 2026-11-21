/**
 * Runs `body` while holding a `deleting_at` claim. Every exit path is
 * explicit: a completed body consumes the claim (the row is gone), and a
 * failed body either releases the claim (retry next tick) or keeps it as the
 * retry fence (retry after the backoff window), as decided by `onFailure`.
 */
export type ClaimDisposition =
	| 'consumed'
	| 'released'
	| 'kept'
	| 'release_failed'

export type ClaimOutcome<T> =
	| { status: 'not_claimed' }
	| { status: 'completed'; value: T; disposition: 'consumed' }
	| {
			status: 'failed'
			error: unknown
			disposition: Exclude<ClaimDisposition, 'consumed'>
			releaseError?: unknown
	  }

export async function runClaimed<C, T>(input: {
	acquire: () => Promise<C | null>
	body: (claim: C) => Promise<T>
	onFailure: (claim: C, error: unknown) => 'release' | 'keep'
	release: (claim: C) => Promise<void>
}): Promise<ClaimOutcome<T>> {
	const claim = await input.acquire()
	if (claim === null) return { status: 'not_claimed' }
	try {
		const value = await input.body(claim)
		return { status: 'completed', value, disposition: 'consumed' }
	} catch (error) {
		if (input.onFailure(claim, error) === 'keep') {
			return { status: 'failed', error, disposition: 'kept' }
		}
		try {
			await input.release(claim)
			return { status: 'failed', error, disposition: 'released' }
		} catch (releaseError) {
			return {
				status: 'failed',
				error,
				disposition: 'release_failed',
				releaseError,
			}
		}
	}
}

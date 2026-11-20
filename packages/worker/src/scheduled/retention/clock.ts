/**
 * Injectable time source for the retention tick. Every read of "now", every
 * pass budget, every timeout, and every retry backoff in the retention lanes
 * goes through a Clock so tests drive time deterministically.
 */
export type Clock = {
	now(): Date
	nowMs(): number
	/** Schedules `callback` after `ms`; returns a canceller. */
	setTimer(ms: number, callback: () => void): () => void
}

export const systemClock: Clock = {
	now: () => new Date(),
	nowMs: () => Date.now(),
	setTimer(ms, callback) {
		const handle = setTimeout(callback, ms)
		return () => clearTimeout(handle)
	},
}

/** Resolves after `ms` on `clock`, or rejects with the signal's reason. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const onAbort = () => {
			cancel()
			reject(signal?.reason)
		}
		const cancel = clock.setTimer(ms, () => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		})
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

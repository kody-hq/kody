import type { Clock } from './clock.ts'
import { RetentionError } from './failures.ts'

/**
 * Runs `run` with an AbortSignal that fires after `timeoutMs` on `clock` or
 * when the parent signal aborts, whichever is first. The returned promise
 * settles at that moment even if the underlying call ignores the signal
 * (D1 bindings do), so a hung call cannot stall a pass past its budget.
 */
export async function withTimeout<T>(input: {
	operation: string
	timeoutMs: number
	clock: Clock
	signal?: AbortSignal
	run: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
	const controller = new AbortController()
	let rejectAbort: (reason: unknown) => void = () => {}
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject
	})
	const abort = (reason: unknown) => {
		if (controller.signal.aborted) return
		controller.abort(reason)
		rejectAbort(reason)
	}
	const onParentAbort = () =>
		abort(
			new RetentionError({
				kind: 'aborted',
				operation: input.operation,
				cause: input.signal?.reason,
			}),
		)
	const cancelTimer = input.clock.setTimer(input.timeoutMs, () =>
		abort(
			new RetentionError({
				kind: 'timed_out',
				operation: input.operation,
				timeoutMs: input.timeoutMs,
			}),
		),
	)
	if (input.signal?.aborted) onParentAbort()
	else input.signal?.addEventListener('abort', onParentAbort, { once: true })
	try {
		return await Promise.race([input.run(controller.signal), aborted])
	} finally {
		cancelTimer()
		input.signal?.removeEventListener('abort', onParentAbort)
	}
}

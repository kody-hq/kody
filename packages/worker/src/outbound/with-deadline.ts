/**
 * Every outbound call on a covered path (D1, KV, R2, Durable Object RPC,
 * fetch, routed context runs) goes through `withDeadline` so a hung call
 * fails with a typed `DeadlineExceededError` instead of stalling the caller.
 * There is no default deadline: each call site names its label and timeout.
 * `kody-custom/require-outbound-deadline` enforces this for the files listed
 * in `tools/oxlint/oxlint-rules.json`.
 */

export type DeadlineClock = {
	/** Run `onExpire` after `ms`; returns a function that cancels it. */
	setTimer: (ms: number, onExpire: () => void) => () => void
}

export const systemDeadlineClock: DeadlineClock = {
	setTimer: (ms, onExpire) => {
		const handle = setTimeout(onExpire, ms)
		return () => clearTimeout(handle)
	},
}

/** Per-call ceilings for outbound calls. */
export const outboundTimeoutMs = {
	d1: 30_000,
	kv: 15_000,
	r2: 30_000,
	durableObject: 150_000,
	http: 30_000,
} as const

export class DeadlineExceededError extends Error {
	readonly kind = 'deadline_exceeded'
	readonly label: string
	readonly timeoutMs: number
	constructor(label: string, timeoutMs: number) {
		super(`${label} exceeded its ${timeoutMs}ms deadline`)
		this.name = 'DeadlineExceededError'
		this.label = label
		this.timeoutMs = timeoutMs
	}
}

export function isDeadlineExceededError(
	error: unknown,
): error is DeadlineExceededError {
	return error instanceof DeadlineExceededError
}

export function withDeadline<T>(
	deadline: { label: string; timeoutMs: number; clock?: DeadlineClock },
	call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const { label, timeoutMs } = deadline
	const controller = new AbortController()
	if (!(timeoutMs > 0)) {
		const error = new DeadlineExceededError(label, timeoutMs)
		controller.abort(error)
		return Promise.reject(error)
	}
	return new Promise<T>((resolve, reject) => {
		const cancel = (deadline.clock ?? systemDeadlineClock).setTimer(
			timeoutMs,
			() => {
				const error = new DeadlineExceededError(label, timeoutMs)
				controller.abort(error)
				reject(error)
			},
		)
		let pending: Promise<T>
		try {
			pending = call(controller.signal)
		} catch (error) {
			cancel()
			reject(error)
			return
		}
		pending.then(
			(value) => {
				cancel()
				resolve(value)
			},
			(error: unknown) => {
				cancel()
				reject(error)
			},
		)
	})
}

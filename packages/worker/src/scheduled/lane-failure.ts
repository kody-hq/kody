/**
 * Shared pieces for typed lane failures. Each lane declares a union of its
 * failure kinds and one mapper that switches over `kind` and ends in
 * `assertNever`, so an unmapped kind is a compile error.
 */

export function assertNever(value: never, context: string): never {
	throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`)
}

/**
 * The one way lane code reports an error it handles without rethrowing.
 * `no-swallowed-lane-error` accepts a catch that calls this.
 */
export function reportLaneError(
	level: 'info' | 'warn' | 'error',
	...details: Array<unknown>
) {
	console[level](...details)
}

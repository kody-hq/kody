import { isDeadlineExceededError } from '@kody-internal/shared/with-deadline.ts'

/**
 * Typed failures for request paths. A step returns (or its edge catches) a
 * `{ kind }` union, and one exhaustive mapper per edge turns each kind into
 * the HTTP error or MCP caller error, ending in `assertNever` so a new kind
 * without a mapping fails the type check.
 */

/** Compile-time exhaustiveness check for the `default` of a failure switch. */
export function assertNever(value: never, context: string): never {
	throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`)
}

export type DeadlineFailure = {
	kind: 'deadline_exceeded'
	label: string
	timeoutMs: number
}

/** The typed failure for an expired `withDeadline` call, else null. */
export function deadlineFailure(error: unknown): DeadlineFailure | null {
	if (!isDeadlineExceededError(error)) return null
	return {
		kind: 'deadline_exceeded',
		label: error.label,
		timeoutMs: error.timeoutMs,
	}
}

/**
 * Runs a step and returns an expired deadline as its typed failure; any
 * other error still throws.
 */
export async function catchDeadline<T>(
	step: () => Promise<T>,
): Promise<T | DeadlineFailure> {
	try {
		return await step()
	} catch (error) {
		const expired = deadlineFailure(error)
		if (!expired) throw error
		return expired
	}
}

/**
 * The one way to keep going after an error a path deliberately tolerates
 * (best-effort cleanup, a fail-closed flag read): it is logged with a label,
 * never dropped. `kody-custom/no-swallowed-error` accepts it in a catch.
 * It logs at info, the repo's operational level, so tolerated errors stay
 * visible in Workers logs without tripping the test console spies.
 */
export function reportHandledError(label: string, error: unknown) {
	console.info(
		JSON.stringify({
			event: 'handled_error',
			label,
			error: error instanceof Error ? error.message : String(error),
		}),
	)
}

/** `JSON.parse` as a typed result, for untrusted or optional JSON text. */
export function parseJsonText(
	text: string,
): { kind: 'ok'; value: unknown } | { kind: 'invalid_json'; message: string } {
	try {
		return { kind: 'ok', value: JSON.parse(text) as unknown }
	} catch (error) {
		return {
			kind: 'invalid_json',
			message: error instanceof Error ? error.message : String(error),
		}
	}
}

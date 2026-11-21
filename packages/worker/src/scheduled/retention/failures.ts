import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'

/**
 * Every way a retention-tick lane can fail as a whole. Per-candidate failures
 * (one account that could not be purged) are results, not lane failures; they
 * are recorded on the lane result and audited.
 */
export type RetentionFailure =
	| {
			kind: 'd1_lock_contention'
			operation: string
			attempts: number
			cause: unknown
	  }
	| { kind: 'd1_query_failed'; operation: string; cause: unknown }
	| { kind: 'row_validation_failed'; operation: string; issues: string }
	| { kind: 'timed_out'; operation: string; timeoutMs: number }
	| { kind: 'aborted'; operation: string; cause: unknown }
	| { kind: 'unexpected'; operation: string; cause: unknown }

export type RetentionFailureKind = RetentionFailure['kind']

export function assertNever(value: never): never {
	throw new Error(`Unhandled retention variant: ${JSON.stringify(value)}`)
}

export function describeRetentionFailure(failure: RetentionFailure): string {
	switch (failure.kind) {
		case 'd1_lock_contention':
		case 'd1_query_failed':
		case 'aborted':
		case 'unexpected':
			return getErrorMessage(failure.cause)
		case 'row_validation_failed':
			return `${failure.operation} returned an invalid row: ${failure.issues}`
		case 'timed_out':
			return `${failure.operation} timed out after ${failure.timeoutMs}ms`
		default:
			return assertNever(failure)
	}
}

/**
 * The typed throw for lane-level failures. The message mirrors the
 * underlying cause so existing log and Sentry grouping stay stable, and the
 * cause chain is kept so D1 lock classification keeps working upstream.
 */
export class RetentionError extends Error {
	readonly failure: RetentionFailure
	constructor(failure: RetentionFailure) {
		const cause =
			'cause' in failure && failure.cause !== undefined
				? failure.cause
				: undefined
		super(describeRetentionFailure(failure), { cause })
		this.name = 'RetentionError'
		this.failure = failure
	}
}

/** Classifies anything thrown inside a lane into a typed failure. */
export function toRetentionFailure(
	operation: string,
	error: unknown,
): RetentionFailure {
	if (error instanceof RetentionError) return error.failure
	if (isRetryableD1LockError(error)) {
		return { kind: 'd1_lock_contention', operation, attempts: 1, cause: error }
	}
	return { kind: 'unexpected', operation, cause: error }
}

/** The original error to report, so Sentry groups on the real cause. */
export function reportableCause(failure: RetentionFailure): unknown {
	switch (failure.kind) {
		case 'd1_lock_contention':
		case 'd1_query_failed':
		case 'aborted':
		case 'unexpected':
			return failure.cause
		case 'row_validation_failed':
		case 'timed_out':
			return new RetentionError(failure)
		default:
			return assertNever(failure)
	}
}

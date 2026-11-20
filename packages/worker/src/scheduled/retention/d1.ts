import type { z } from 'zod'
import {
	classifyRetryableD1Error,
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	isRetryableD1LockError,
} from '#worker/d1-retry.ts'
import type { Clock } from './clock.ts'
import { RetentionError } from './failures.ts'
import { transientRetriesSpent } from './item-retry.ts'
import { d1ChangesMetaSchema, formatIssues } from './rows.ts'
import { retry, type RetryPolicy } from './retry.ts'
import { traced } from './telemetry.ts'
import { withTimeout } from './timeout.ts'

/** Per-attempt ceiling for one D1 statement in a retention pass. */
export const retentionD1AttemptTimeoutMs = 10_000

export type RetentionContext = {
	db: D1Database
	clock: Clock
	signal?: AbortSignal
}

function isTimeout(error: unknown) {
	return error instanceof RetentionError && error.failure.kind === 'timed_out'
}

/**
 * Same backoff schedule and lock classification as `runD1WithRetry`. An
 * error an item retry scope already retried (`item-retry.ts`) is final.
 */
function d1Policy(retryOnTimeout: boolean): RetryPolicy {
	return {
		maxAttempts: d1LockRetryMaxAttempts,
		baseDelayMs: d1LockRetryBaseDelayMs,
		jitter: (error) =>
			classifyRetryableD1Error(error) === 'overloaded' ? 'half' : 'none',
		isRetryable: (error) =>
			!transientRetriesSpent(error) &&
			(isRetryableD1LockError(error) || (retryOnTimeout && isTimeout(error))),
	}
}

async function executeD1<T>(
	ctx: RetentionContext,
	input: {
		operation: string
		/** Reads retry an attempt timeout; writes do not (the write may have landed). */
		idempotent: boolean
		run: () => Promise<T>
	},
): Promise<T> {
	const result = await retry({
		policy: d1Policy(input.idempotent),
		clock: ctx.clock,
		signal: ctx.signal,
		attempt: () =>
			withTimeout({
				operation: input.operation,
				timeoutMs: retentionD1AttemptTimeoutMs,
				clock: ctx.clock,
				signal: ctx.signal,
				run: () => input.run(),
			}),
	})
	if (result.ok) return result.value
	const { error } = result
	if (error instanceof RetentionError) throw error
	throw new RetentionError(
		isRetryableD1LockError(error)
			? {
					kind: 'd1_lock_contention',
					operation: input.operation,
					attempts: result.attempts,
					cause: error,
				}
			: { kind: 'd1_query_failed', operation: input.operation, cause: error },
	)
}

function parseRow<S extends z.ZodType>(
	operation: string,
	schema: S,
	row: unknown,
): z.output<S> {
	const parsed = schema.safeParse(row)
	if (!parsed.success) {
		throw new RetentionError({
			kind: 'row_validation_failed',
			operation,
			issues: formatIssues(parsed.error),
		})
	}
	return parsed.data
}

export type D1Query<S extends z.ZodType> = {
	operation: string
	sql: string
	bindings?: ReadonlyArray<unknown>
	row: S
}

/** SELECT many rows; every row is schema-validated. */
export function d1All<S extends z.ZodType>(
	ctx: RetentionContext,
	query: D1Query<S>,
): Promise<Array<z.output<S>>> {
	return traced(
		`retention.d1.${query.operation}`,
		{ 'db.operation': 'all' },
		async (span) => {
			const { results } = await executeD1(ctx, {
				operation: query.operation,
				idempotent: true,
				run: () =>
					ctx.db
						.prepare(query.sql)
						.bind(...(query.bindings ?? []))
						.all<unknown>(),
			})
			span.setAttribute('db.rows', results.length)
			return results.map((row) => parseRow(query.operation, query.row, row))
		},
		ctx.clock,
	)
}

/** SELECT at most one row; a present row is schema-validated. */
export function d1First<S extends z.ZodType>(
	ctx: RetentionContext,
	query: D1Query<S>,
): Promise<z.output<S> | null> {
	return traced(
		`retention.d1.${query.operation}`,
		{ 'db.operation': 'first' },
		async () => {
			const row = await executeD1(ctx, {
				operation: query.operation,
				idempotent: true,
				run: () =>
					ctx.db
						.prepare(query.sql)
						.bind(...(query.bindings ?? []))
						.first<unknown>(),
			})
			return row === null ? null : parseRow(query.operation, query.row, row)
		},
		ctx.clock,
	)
}

/** INSERT/UPDATE/DELETE; returns the validated `meta.changes`. */
export function d1Run(
	ctx: RetentionContext,
	statement: {
		operation: string
		sql: string
		bindings?: ReadonlyArray<unknown>
	},
): Promise<number> {
	return traced(
		`retention.d1.${statement.operation}`,
		{ 'db.operation': 'run' },
		async (span) => {
			const result = await executeD1(ctx, {
				operation: statement.operation,
				idempotent: false,
				run: () =>
					ctx.db
						.prepare(statement.sql)
						.bind(...(statement.bindings ?? []))
						.run(),
			})
			const { changes } = parseRow(
				statement.operation,
				d1ChangesMetaSchema,
				result.meta,
			)
			span.setAttribute('db.changes', changes)
			return changes
		},
		ctx.clock,
	)
}

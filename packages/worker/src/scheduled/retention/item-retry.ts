import * as Sentry from '@sentry/cloudflare'
import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { classifyRetryableD1Error } from '#worker/d1-retry.ts'
import type { Clock } from './clock.ts'
import {
	reportableCause,
	RetentionError,
	type TransientRetryBudgetExhausted,
} from './failures.ts'
import { retry, type RetryPolicy } from './retry.ts'

/** D1 error messages the purge lanes treat as transient and retry per item. */
const transientD1ErrorMarkers = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'reset because its code was updated',
	'D1_ERROR: internal error',
] as const

function isTransientD1Error(error: unknown) {
	return errorCauseChainIncludes(error, (message) =>
		transientD1ErrorMarkers.some((marker) => message.includes(marker)),
	)
}

/** Three retries per statement or batch: 100 ms, 200 ms, 400 ms. */
const transientD1RetryPolicy: RetryPolicy = {
	maxAttempts: 4,
	baseDelayMs: 100,
	jitter: () => 'none',
	isRetryable: isTransientD1Error,
}

/** Total backoff one purge item may spend across all of its statements. */
const itemTransientRetryBudgetMs = 1_000

const retriedErrors = new WeakSet<object>()

/** True for a transient error an item scope already retried to exhaustion. */
export function transientRetriesSpent(error: unknown) {
	return typeof error === 'object' && error !== null && retriedErrors.has(error)
}

type ItemRetry = {
	/** The same database with every statement and batch retried in this scope. */
	wrap(db: D1Database): D1Database
	spentMs(): number
	/** Set once the budget ran out; every later statement then fails fast. */
	exhausted(): TransientRetryBudgetExhausted | null
}

const originalStatements = new WeakMap<object, D1PreparedStatement>()

/**
 * Retry scope for one purge item (one org, one user, or one personal org plus
 * user pair). Wrapping the D1 binding, rather than each call site, also
 * covers the shared deletion helpers that take `env` and call D1 directly.
 * Backoff sleeps on the lane clock, so it counts toward the pass budget.
 */
export function startItemRetry(input: {
	clock: Clock
	signal?: AbortSignal
	budgetMs?: number
}): ItemRetry {
	const budgetMs = input.budgetMs ?? itemTransientRetryBudgetMs
	let spentMs = 0
	let exhausted: TransientRetryBudgetExhausted | null = null
	const execute = async <T>(
		operation: string,
		attempt: () => Promise<T>,
	): Promise<T> => {
		if (exhausted) throw new RetentionError(exhausted)
		const result = await retry({
			policy: transientD1RetryPolicy,
			clock: input.clock,
			signal: input.signal,
			reserveBackoff: (delayMs) => {
				if (spentMs + delayMs > budgetMs) return false
				spentMs += delayMs
				return true
			},
			attempt,
		})
		if (result.ok) return result.value
		if (result.budgetExhausted) {
			exhausted = {
				kind: 'transient_retry_budget_exhausted',
				operation,
				budgetMs,
				spentMs,
				lastError: result.error,
			}
			throw new RetentionError(exhausted)
		}
		const { error } = result
		if (result.retryable && typeof error === 'object' && error !== null) {
			retriedErrors.add(error)
		}
		throw error
	}
	const wrapStatement = (
		statement: D1PreparedStatement,
	): D1PreparedStatement => {
		const call =
			(method: 'first' | 'run' | 'all' | 'raw') =>
			(...args: Array<unknown>) =>
				execute(
					`d1.${method}`,
					() =>
						Reflect.apply(
							statement[method],
							statement,
							args,
						) as Promise<unknown>,
				)
		const wrapped = {
			bind: (...values: Array<unknown>) =>
				wrapStatement(statement.bind(...values)),
			first: call('first'),
			run: call('run'),
			all: call('all'),
			raw: call('raw'),
		} as unknown as D1PreparedStatement
		originalStatements.set(wrapped, statement)
		return wrapped
	}
	return {
		wrap: (db) =>
			({
				prepare: (sql: string) => wrapStatement(db.prepare(sql)),
				batch: (statements: Array<D1PreparedStatement>) =>
					execute('d1.batch', () =>
						db.batch(
							statements.map(
								(statement) => originalStatements.get(statement) ?? statement,
							),
						),
					),
				exec: (sql: string) => execute('d1.exec', () => db.exec(sql)),
			}) as unknown as D1Database,
		spentMs: () => spentMs,
		exhausted: () => exhausted,
	}
}

/** Sentry event for an item that spent its retry budget; stable ids only. */
export function reportRetryBudgetExhausted(input: {
	lane: 'soft_delete_purge' | 'unverified_account_purge'
	ownerId: string
	failure: TransientRetryBudgetExhausted
}) {
	Sentry.withScope((scope) => {
		scope.setTag('scheduled.lane', input.lane)
		scope.setTag('retention.failure_kind', input.failure.kind)
		scope.setContext('retention_item', {
			ownerId: input.ownerId,
			operation: input.failure.operation,
			spentMs: input.failure.spentMs,
			budgetMs: input.failure.budgetMs,
			transientKind: classifyRetryableD1Error(input.failure.lastError),
		})
		Sentry.captureException(reportableCause(input.failure))
	})
}

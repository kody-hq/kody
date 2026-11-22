/**
 * Per-item retry for transient D1 errors in the purge lanes
 * (`soft_delete_purge`, `unverified_account_purge`).
 *
 * A lane wraps the env it hands to one item (one org, one user, or one
 * personal org plus user pair) with {@link withTransientD1RetryEnv}. Every D1
 * statement or batch that item runs, including inside shared helpers such as
 * `deleteUserAccount`, then retries transient errors up to three times with a
 * fixed 100/200/400 ms backoff. The backoff spent across the whole item is
 * capped by one {@link TransientD1RetryBudget}; the retry that would overshoot
 * it throws {@link TransientRetryBudgetExhausted} instead of sleeping.
 *
 * Errors leaving the wrapper are marked handled so an enclosing
 * `runD1WithRetry` does not retry them again.
 *
 * Shared helpers that also serve non-purge callers and receive the lane's
 * plain env (`deleteUserAccount`) opt in through
 * {@link withScopedTransientD1Retry}, which wraps only inside
 * {@link runInTransientD1RetryScope}.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Sentry from '@sentry/cloudflare'
import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { markD1RetryHandled } from '#worker/d1-retry.ts'
import { reportLaneError } from '#worker/scheduled/lane-failure.ts'

export const transientD1ErrorMarkers = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'reset because its code was updated',
	'D1_ERROR: internal error',
] as const

export const transientD1RetryDelaysMs = [100, 200, 400] as const

export const transientD1ItemRetryBudgetMs = 1_000

/** Time source for a lane pass; tests inject one that advances on `sleep`. */
export type LaneClock = {
	now: () => number
	sleep: (ms: number) => Promise<void>
}

export const systemLaneClock: LaneClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

export function isTransientD1Error(error: unknown) {
	return errorCauseChainIncludes(error, (message) =>
		transientD1ErrorMarkers.some((marker) => message.includes(marker)),
	)
}

export class TransientRetryBudgetExhausted extends Error {
	readonly label: string
	readonly spentMs: number
	readonly budgetMs: number
	readonly nextDelayMs: number
	/** The transient D1 error the skipped retry would have retried. */
	readonly lastError: unknown

	constructor(input: {
		label: string
		spentMs: number
		budgetMs: number
		nextDelayMs: number
		lastError: unknown
	}) {
		super(
			`Transient D1 retry budget exhausted: ${input.label} needed ${input.nextDelayMs} ms more backoff after ${input.spentMs} of ${input.budgetMs} ms`,
		)
		this.name = 'TransientRetryBudgetExhausted'
		this.label = input.label
		this.spentMs = input.spentMs
		this.budgetMs = input.budgetMs
		this.nextDelayMs = input.nextDelayMs
		this.lastError = input.lastError
	}
}

/** Backoff budget shared by every D1 call of one purge item. */
export type TransientD1RetryBudget = {
	readonly budgetMs: number
	spentMs: number
	/** First exhaustion for the item; set even if a helper swallows the throw. */
	exhausted: TransientRetryBudgetExhausted | null
}

export function createTransientD1RetryBudget(
	budgetMs: number = transientD1ItemRetryBudgetMs,
): TransientD1RetryBudget {
	return { budgetMs, spentMs: 0, exhausted: null }
}

type TransientD1RetryOptions = {
	clock: LaneClock
	/** Omit for lane reads that do not belong to one item. */
	budget?: TransientD1RetryBudget
}

export async function runWithTransientD1Retry<T>(
	label: string,
	operation: () => Promise<T>,
	options: TransientD1RetryOptions,
): Promise<T> {
	for (let retry = 0; ; retry++) {
		try {
			return await operation()
		} catch (error) {
			const delayMs = transientD1RetryDelaysMs[retry]
			if (delayMs === undefined || !isTransientD1Error(error)) {
				throw markD1RetryHandled(error)
			}
			const { budget } = options
			if (budget) {
				if (budget.spentMs + delayMs > budget.budgetMs) {
					const exhausted = new TransientRetryBudgetExhausted({
						label,
						spentMs: budget.spentMs,
						budgetMs: budget.budgetMs,
						nextDelayMs: delayMs,
						lastError: error,
					})
					budget.exhausted ??= exhausted
					throw markD1RetryHandled(exhausted)
				}
				budget.spentMs += delayMs
			}
			await options.clock.sleep(delayMs)
		}
	}
}

const retriedStatementMethods = new Set<PropertyKey>([
	'run',
	'all',
	'first',
	'raw',
])

function withTransientD1RetryDatabase(
	db: D1Database,
	binding: string,
	options: TransientD1RetryOptions,
): D1Database {
	// D1 `batch` only accepts the binding's own statements, so unwrap them.
	const originals = new WeakMap<object, D1PreparedStatement>()
	const wrapStatement = (
		statement: D1PreparedStatement,
	): D1PreparedStatement => {
		const wrapped = new Proxy(statement, {
			get(target, property) {
				const value: unknown = Reflect.get(target, property, target)
				if (typeof value !== 'function') return value
				if (property === 'bind') {
					return (...args: Array<unknown>) =>
						wrapStatement(Reflect.apply(value, target, args))
				}
				if (retriedStatementMethods.has(property)) {
					return (...args: Array<unknown>) =>
						runWithTransientD1Retry(
							`${binding}.${String(property)}`,
							() => Reflect.apply(value, target, args),
							options,
						)
				}
				return value.bind(target)
			},
		})
		originals.set(wrapped, statement)
		return wrapped
	}
	return new Proxy(db, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target)
			if (typeof value !== 'function') return value
			if (property === 'prepare') {
				return (query: string) =>
					wrapStatement(Reflect.apply(value, target, [query]))
			}
			if (property === 'batch') {
				return (statements: Array<D1PreparedStatement>) =>
					runWithTransientD1Retry(
						`${binding}.batch`,
						() =>
							Reflect.apply(value, target, [
								statements.map(
									(statement) => originals.get(statement) ?? statement,
								),
							]),
						options,
					)
			}
			if (property === 'exec') {
				return (query: string) =>
					runWithTransientD1Retry(
						`${binding}.exec`,
						() => Reflect.apply(value, target, [query]),
						options,
					)
			}
			return value.bind(target)
		},
	})
}

const transientD1RetryEnvs = new WeakSet<object>()

/** `env` with `APP_DB` (and `AUDIT_DB` when bound) retrying transient errors. */
export function withTransientD1RetryEnv<TEnv extends Env>(
	env: TEnv,
	options: TransientD1RetryOptions,
): TEnv {
	if (transientD1RetryEnvs.has(env)) return env
	const appDb = withTransientD1RetryDatabase(env.APP_DB, 'APP_DB', options)
	const auditDb = env.AUDIT_DB
		? withTransientD1RetryDatabase(env.AUDIT_DB, 'AUDIT_DB', options)
		: env.AUDIT_DB
	const wrapped = new Proxy(env, {
		get(target, property, receiver) {
			if (property === 'APP_DB') return appDb
			if (property === 'AUDIT_DB') return auditDb
			return Reflect.get(target, property, receiver)
		},
	})
	transientD1RetryEnvs.add(wrapped)
	return wrapped
}

const transientD1RetryScope = new AsyncLocalStorage<TransientD1RetryOptions>()

/** Runs one purge item so scoped helpers share its clock and budget. */
export function runInTransientD1RetryScope<T>(
	options: TransientD1RetryOptions,
	operation: () => Promise<T>,
): Promise<T> {
	return transientD1RetryScope.run(options, operation)
}

/** `env` wrapped for the active purge item, or unchanged outside one. */
export function withScopedTransientD1Retry<TEnv extends Env>(env: TEnv): TEnv {
	const options = transientD1RetryScope.getStore()
	return options ? withTransientD1RetryEnv(env, options) : env
}

/** Stable ids and budget numbers only: no emails or provider text. */
export function reportTransientRetryBudgetExhaustedToSentry(input: {
	lane: 'soft_delete_purge' | 'unverified_account_purge'
	itemKind: 'org' | 'user'
	itemId: string
	error: TransientRetryBudgetExhausted
}) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', input.lane)
			scope.setTag('purge.failure', 'retry_budget_exhausted')
			scope.setContext('transient_retry_budget', {
				itemKind: input.itemKind,
				itemId: input.itemId,
				label: input.error.label,
				spentMs: input.error.spentMs,
				budgetMs: input.error.budgetMs,
				nextDelayMs: input.error.nextDelayMs,
				lastError: getErrorMessage(input.error.lastError).slice(0, 200),
			})
			Sentry.captureException(input.error)
		})
	} catch (sentryError) {
		reportLaneError('warn', `${input.lane}_retry_budget_sentry_failed`, {
			itemKind: input.itemKind,
			itemId: input.itemId,
			error: sentryError,
		})
	}
}

import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { markD1RetrySettled } from '#worker/d1-retry.ts'

/** Backoff before each retry of one D1 statement or batch. No jitter. */
export const transientD1RetryDelaysMs = [100, 200, 400] as const

/** Total backoff one purge item may spend across all of its statements. */
export const transientD1ItemRetryBudgetMs = 1_000

const transientD1ErrorMarkers = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'reset because its code was updated',
	'D1_ERROR: internal error',
] as const

export function isTransientD1Error(error: unknown) {
	const message = getErrorMessage(error)
	return transientD1ErrorMarkers.some((marker) => message.includes(marker))
}

/**
 * One purge item (an org, a user, or a person plus personal org) hit a
 * transient D1 error whose next retry would push its total backoff past the
 * item budget. The item fails and keeps its claim, so the lane retries it
 * after the claim fence.
 */
export class TransientRetryBudgetExhausted extends Error {
	readonly spentMs: number
	readonly budgetMs: number

	constructor(input: { spentMs: number; budgetMs: number; cause: unknown }) {
		super(
			`Transient D1 retry budget exhausted after ${input.spentMs}ms of ${input.budgetMs}ms backoff`,
			{ cause: input.cause },
		)
		this.name = 'TransientRetryBudgetExhausted'
		this.spentMs = input.spentMs
		this.budgetMs = input.budgetMs
	}
}

type ItemRetryEnv = { APP_DB: D1Database; AUDIT_DB?: D1Database }

const attachedItemRetry = Symbol('transientD1ItemRetry')

type AttachedItemRetryEnv = { [attachedItemRetry]?: TransientD1ItemRetry }

/**
 * The env a shared helper should run D1 through: wrapped by the item retry
 * attached with {@link TransientD1ItemRetry.attach}, or unchanged.
 */
export function transientD1ItemRetryEnv<E extends ItemRetryEnv>(env: E): E {
	const retry = (env as E & AttachedItemRetryEnv)[attachedItemRetry]
	return retry ? retry.env(env) : env
}

const d1ExecutingMethods = new Set<PropertyKey>(['first', 'run', 'all', 'raw'])

/**
 * Per-item retry for transient D1 errors. Every statement or batch run
 * through {@link TransientD1ItemRetry.env} or
 * {@link TransientD1ItemRetry.database} retries transient errors with
 * {@link transientD1RetryDelaysMs}, and all of them share one backoff budget.
 * Errors leaving this layer are marked settled so an outer `runD1WithRetry`
 * does not retry them again.
 */
export class TransientD1ItemRetry {
	readonly #sleep: (ms: number) => Promise<void>
	readonly #budgetMs: number
	readonly #rawStatements = new WeakMap<object, D1PreparedStatement>()
	#spentMs = 0
	#exhausted: TransientRetryBudgetExhausted | null = null

	constructor(input: {
		sleep: (ms: number) => Promise<void>
		budgetMs?: number
	}) {
		this.#sleep = input.sleep
		this.#budgetMs = input.budgetMs ?? transientD1ItemRetryBudgetMs
	}

	get spentMs() {
		return this.#spentMs
	}

	get exhausted() {
		return this.#exhausted
	}

	/** The item's failure: budget exhaustion wins over whatever wrapped it. */
	failure(error: unknown): unknown {
		return this.#exhausted ?? error
	}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		for (let retry = 0; ; retry += 1) {
			try {
				return await operation()
			} catch (error) {
				if (
					!isTransientD1Error(error) ||
					retry >= transientD1RetryDelaysMs.length
				)
					throw markD1RetrySettled(error)
				const delayMs = transientD1RetryDelaysMs[retry]!
				if (this.#exhausted || this.#spentMs + delayMs > this.#budgetMs) {
					this.#exhausted ??= new TransientRetryBudgetExhausted({
						spentMs: this.#spentMs,
						budgetMs: this.#budgetMs,
						cause: error,
					})
					throw markD1RetrySettled(this.#exhausted)
				}
				this.#spentMs += delayMs
				await this.#sleep(delayMs)
			}
		}
	}

	/** The env with its D1 bindings wrapped by this retry. */
	env<E extends ItemRetryEnv>(env: E): E {
		return {
			...env,
			APP_DB: this.database(env.APP_DB),
			...(env.AUDIT_DB ? { AUDIT_DB: this.database(env.AUDIT_DB) } : {}),
		}
	}

	/**
	 * A copy of the env with its bindings untouched and this retry attached
	 * as a non-enumerable property, for shared helpers that resolve it with
	 * {@link transientD1ItemRetryEnv}. Helpers that hand the env to non-D1
	 * clients (Stripe) keep passing this copy unchanged.
	 */
	attach<E extends ItemRetryEnv>(env: E): E {
		return Object.defineProperty({ ...env }, attachedItemRetry, {
			value: this,
			enumerable: false,
		})
	}

	database(db: D1Database): D1Database {
		return new Proxy(db, {
			get: (target, property) => {
				if (property === 'prepare')
					return (query: string) => this.#statement(target.prepare(query))
				if (property === 'batch')
					return (statements: Array<D1PreparedStatement>) =>
						this.run(() =>
							target.batch(
								statements.map(
									(statement) =>
										this.#rawStatements.get(statement) ?? statement,
								),
							),
						)
				const value: unknown = Reflect.get(target, property, target)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	}

	#statement(statement: D1PreparedStatement): D1PreparedStatement {
		const wrapped = new Proxy(statement, {
			get: (target, property) => {
				if (property === 'bind')
					return (...values: Array<unknown>) =>
						this.#statement(target.bind(...values))
				const value: unknown = Reflect.get(target, property, target)
				if (typeof value !== 'function') return value
				if (!d1ExecutingMethods.has(property)) return value.bind(target)
				return (...args: Array<unknown>) =>
					this.run(() => value.apply(target, args) as Promise<unknown>)
			},
		})
		this.#rawStatements.set(wrapped, statement)
		return wrapped
	}
}

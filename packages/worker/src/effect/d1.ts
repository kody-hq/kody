import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	classifyRetryableD1Error,
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	isRetryableD1LockError,
} from '#worker/d1-retry.ts'
import {
	Cause,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Random,
	Schedule,
	Schema,
} from 'effect'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	'DatabaseError',
	{
		operation: Schema.String,
		reason: Schema.Literals(['query', 'timeout', 'row_schema']),
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {
	/** Lock contention and platform resets D1 reports as retryable. */
	get retryable() {
		return this.reason === 'query' && isRetryableD1LockError(this.cause)
	}
}

export type Bound = string | number | null

export type Statement = {
	readonly sql: string
	readonly params: ReadonlyArray<Bound>
}

export const sql = (text: string, ...params: Array<Bound>): Statement => ({
	sql: text,
	params,
})

export type RowSchema<A> = Schema.Decoder<A>

export type RunResult = { readonly changes: number }

/** D1 cannot abort a query; this bounds how long a lane waits for one. */
export const d1QueryTimeout = Duration.seconds(30)

/**
 * D1 with schema-checked reads. A row that does not match its schema (a
 * drifted column, a NULL where none is expected) fails at the read as a
 * `DatabaseError`, not later as an `undefined` deep in the caller.
 */
export class D1 extends Context.Service<
	D1,
	{
		first<A>(
			operation: string,
			schema: RowSchema<A>,
			statement: Statement,
		): Effect.Effect<Option.Option<A>, DatabaseError>
		all<A>(
			operation: string,
			schema: RowSchema<A>,
			statement: Statement,
		): Effect.Effect<ReadonlyArray<A>, DatabaseError>
		run(
			operation: string,
			statement: Statement,
		): Effect.Effect<RunResult, DatabaseError>
		batch(
			operation: string,
			statements: ReadonlyArray<Statement>,
		): Effect.Effect<ReadonlyArray<RunResult>, DatabaseError>
	}
>()('kody/effect/D1') {
	static readonly layer = (db: D1Database) =>
		Layer.succeed(
			D1,
			makeD1(() => db),
		)

	/** `APP_DB`, read on every query so a swapped binding is never stale. */
	static readonly fromWorkerEnv = Layer.effect(
		D1,
		Effect.gen(function* () {
			const env = yield* WorkerEnv
			return makeD1(() => env.APP_DB)
		}),
	)
}

export function makeD1(database: () => D1Database): D1['Service'] {
	const prepare = (statement: Statement) =>
		database()
			.prepare(statement.sql)
			.bind(...statement.params)

	const query = <A>(operation: string, evaluate: () => Promise<A>) =>
		Effect.tryPromise({
			try: evaluate,
			catch: (cause) =>
				new DatabaseError({
					operation,
					reason: 'query',
					message: getErrorMessage(cause),
					cause,
				}),
		}).pipe(
			Effect.timeoutOrElse({
				duration: d1QueryTimeout,
				orElse: () =>
					Effect.fail(
						new DatabaseError({
							operation,
							reason: 'timeout',
							message: `D1 ${operation} timed out.`,
							cause: null,
						}),
					),
			}),
		)

	const decode = <A>(operation: string, schema: RowSchema<A>, row: unknown) =>
		Schema.decodeUnknownEffect(schema)(row).pipe(
			Effect.mapError(
				(cause) =>
					new DatabaseError({
						operation,
						reason: 'row_schema',
						message: `D1 ${operation} returned an unexpected row: ${cause.message}`,
						cause,
					}),
			),
		)

	return D1.of({
		first: Effect.fn('D1.first')(function* (operation, schema, statement) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const row = yield* query(operation, () => prepare(statement).first())
			if (row === null) return Option.none()
			return Option.some(yield* decode(operation, schema, row))
		}),
		all: Effect.fn('D1.all')(function* (operation, schema, statement) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const result = yield* query(operation, () => prepare(statement).all())
			return yield* Effect.forEach(result.results ?? [], (row) =>
				decode(operation, schema, row),
			)
		}),
		run: Effect.fn('D1.run')(function* (operation, statement) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const result = yield* query(operation, () => prepare(statement).run())
			return { changes: result.meta?.changes ?? 0 }
		}),
		batch: Effect.fn('D1.batch')(function* (operation, statements) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const results = yield* query(operation, () =>
				database().batch(statements.map(prepare)),
			)
			return results.map((result) => ({ changes: result.meta?.changes ?? 0 }))
		}),
	})
}

/**
 * Exponential backoff from `d1LockRetryBaseDelayMs`; {@link retryTransientD1}
 * caps it at `d1LockRetryMaxAttempts` attempts. Overloaded databases get half-jittered
 * delays so a fleet of retries does not land on the same instant.
 */
export const d1RetrySchedule = Schedule.exponential(
	Duration.millis(d1LockRetryBaseDelayMs),
).pipe(
	Schedule.modifyDelay(
		({ input, duration }: Schedule.Metadata<unknown, DatabaseError>) =>
			classifyRetryableD1Error(input.cause) === 'overloaded'
				? Effect.map(Random.next, (random) =>
						Duration.millis(
							Duration.toMillis(duration) / 2 +
								random * (Duration.toMillis(duration) / 2),
						),
					)
				: Effect.succeed(duration),
	),
)

/** Retries a D1 effect while its failure is lock contention or a reset. */
export const retryTransientD1 = <A, R>(
	effect: Effect.Effect<A, DatabaseError, R>,
): Effect.Effect<A, DatabaseError, R> =>
	Effect.retry(effect, {
		schedule: d1RetrySchedule,
		times: d1LockRetryMaxAttempts - 1,
		while: (error: DatabaseError) => error.retryable,
	})

/**
 * D1 failures the purge lanes retry: a dropped binding connection, a storage
 * timeout, a Durable Object reset by a deploy, and D1's opaque internal error.
 * Every other failure is permanent.
 */
export const transientD1ErrorMessages = [
	'Network connection lost',
	'storage operation exceeded timeout',
	'reset because its code was updated',
	'D1_ERROR: internal error',
] as const

export const isTransientD1Error = (error: DatabaseError) =>
	error.reason === 'query' &&
	transientD1ErrorMessages.some((marker) => error.message.includes(marker))

/** Backoff before each retry of one transient D1 statement or batch. */
export const transientD1RetryDelaysMs = [100, 200, 400] as const
/** Total backoff one purge item may spend across all of its statements. */
export const transientD1RetryBudgetMs = 1_000

/** A purge item would have crossed its transient D1 backoff budget. */
export class TransientRetryBudgetExhausted extends Schema.TaggedError<TransientRetryBudgetExhausted>()(
	'TransientRetryBudgetExhausted',
	{
		operation: Schema.String,
		spentMs: Schema.Number,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Runs one purge item (an org, a user, or a person with their personal org)
 * against a `D1` that retries each transient statement or batch after
 * {@link transientD1RetryDelaysMs}. Backoff is shared by every statement of
 * the item; the retry that would cross {@link transientD1RetryBudgetMs} is not
 * taken and the item fails with `TransientRetryBudgetExhausted`, even when a
 * helper wrapped the D1 failure in its own error first. Backoff sleeps on
 * `Clock`, so it counts toward the pass budget.
 */
export const withTransientRetryBudget = Effect.fnUntraced(function* <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | TransientRetryBudgetExhausted, R | D1> {
	const db = yield* D1
	let spentMs = 0
	let exhausted: TransientRetryBudgetExhausted | undefined
	const retrying = <B>(
		operation: string,
		attempt: Effect.Effect<B, DatabaseError>,
		retry = 0,
	): Effect.Effect<B, DatabaseError> =>
		Effect.catch(attempt, (error) => {
			const delayMs = transientD1RetryDelaysMs[retry]
			if (delayMs === undefined || exhausted || !isTransientD1Error(error)) {
				return Effect.fail(error)
			}
			if (spentMs + delayMs > transientD1RetryBudgetMs) {
				exhausted = new TransientRetryBudgetExhausted({
					operation,
					spentMs,
					message: `D1 ${operation} stopped retrying after ${spentMs} ms of transient backoff for this item.`,
					cause: error,
				})
				return Effect.fail(error)
			}
			spentMs += delayMs
			return Effect.logDebug('transient d1 retry', {
				operation,
				delayMs,
			}).pipe(
				Effect.andThen(Effect.sleep(Duration.millis(delayMs))),
				Effect.andThen(retrying(operation, attempt, retry + 1)),
			)
		})
	const budgeted = D1.of({
		first: (operation, schema, statement) =>
			retrying(operation, db.first(operation, schema, statement)),
		all: (operation, schema, statement) =>
			retrying(operation, db.all(operation, schema, statement)),
		run: (operation, statement) =>
			retrying(operation, db.run(operation, statement)),
		batch: (operation, statements) =>
			retrying(operation, db.batch(operation, statements)),
	})
	return yield* effect.pipe(
		Effect.provideService(D1, budgeted),
		Effect.catchCause(
			(cause): Effect.Effect<never, E | TransientRetryBudgetExhausted> =>
				exhausted && Cause.hasFails(cause)
					? Effect.fail(exhausted)
					: Effect.failCause(cause),
		),
	)
})

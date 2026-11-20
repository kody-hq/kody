import { Context, Effect, Layer, Option, Schema } from 'effect'

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	'DatabaseError',
	{
		operation: Schema.String,
		reason: Schema.Literals(['query', 'timeout', 'row_schema']),
		cause: Schema.Defect(),
	},
) {}

type Bound = string | number | null

export type Statement = {
	readonly sql: string
	readonly params: ReadonlyArray<Bound>
}

export const sql = (text: string, ...params: Array<Bound>): Statement => ({
	sql: text,
	params,
})

type RowSchema<A> = Schema.Decoder<A>

/** D1 cannot abort a query; this bounds how long a request waits for one. */
const queryTimeout = '10 seconds'

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
		): Effect.Effect<{ readonly changes: number }, DatabaseError>
		batch(
			operation: string,
			statements: ReadonlyArray<Statement>,
		): Effect.Effect<ReadonlyArray<{ readonly changes: number }>, DatabaseError>
	}
>()('kody/effect/D1') {
	static readonly layer = (db: D1Database) => Layer.succeed(D1, makeD1(db))
}

function makeD1(db: D1Database): D1['Service'] {
	const prepare = (statement: Statement) =>
		db.prepare(statement.sql).bind(...statement.params)

	const query = <A>(operation: string, evaluate: () => Promise<A>) =>
		Effect.tryPromise({
			try: evaluate,
			catch: (cause) =>
				new DatabaseError({ operation, reason: 'query', cause }),
		}).pipe(
			Effect.timeoutOrElse({
				duration: queryTimeout,
				orElse: () =>
					Effect.fail(
						new DatabaseError({ operation, reason: 'timeout', cause: null }),
					),
			}),
		)

	const decode = <A>(operation: string, schema: RowSchema<A>, row: unknown) =>
		Schema.decodeUnknownEffect(schema)(row).pipe(
			Effect.mapError(
				(cause) =>
					new DatabaseError({ operation, reason: 'row_schema', cause }),
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
			return yield* Effect.forEach(result.results, (row) =>
				decode(operation, schema, row),
			)
		}),
		run: Effect.fn('D1.run')(function* (operation, statement) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const result = yield* query(operation, () => prepare(statement).run())
			return { changes: result.meta.changes ?? 0 }
		}),
		batch: Effect.fn('D1.batch')(function* (operation, statements) {
			yield* Effect.annotateCurrentSpan('db.operation', operation)
			const results = yield* query(operation, () =>
				db.batch(statements.map(prepare)),
			)
			return results.map((result) => ({ changes: result.meta?.changes ?? 0 }))
		}),
	})
}

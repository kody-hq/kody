import { Context, Effect, Layer, Option, Schema } from 'effect'

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	'DatabaseError',
	{
		query: Schema.String,
		reason: Schema.Literals(['query_failed', 'row_shape']),
		cause: Schema.Defect(),
	},
) {}

type D1Param = string | number | null

type D1Query = {
	/** Span and error label, e.g. `newsletter.findConfirmedSubscriber`. */
	readonly name: string
	readonly sql: string
	readonly params?: ReadonlyArray<D1Param>
}

type D1RowQuery<Row> = D1Query & {
	readonly row: Schema.Decoder<Row>
}

/**
 * D1 with row schemas: every read names the shape it expects, so a drifted
 * column fails as a `DatabaseError` instead of flowing on as `undefined`.
 */
export class D1 extends Context.Service<
	D1,
	{
		readonly first: <Row>(
			query: D1RowQuery<Row>,
		) => Effect.Effect<Option.Option<Row>, DatabaseError>
		readonly all: <Row>(
			query: D1RowQuery<Row>,
		) => Effect.Effect<ReadonlyArray<Row>, DatabaseError>
		readonly run: (
			query: D1Query,
		) => Effect.Effect<{ readonly changes: number }, DatabaseError>
		readonly batch: (
			name: string,
			queries: ReadonlyArray<Omit<D1Query, 'name'>>,
		) => Effect.Effect<
			ReadonlyArray<{ readonly changes: number }>,
			DatabaseError
		>
	}
>()('kody/effect/D1') {
	static layer(db: D1Database) {
		return Layer.succeed(D1, makeD1(db))
	}
}

function makeD1(db: D1Database): D1['Service'] {
	const prepare = (query: Omit<D1Query, 'name'>) =>
		db.prepare(query.sql).bind(...(query.params ?? []))

	const execute = <A>(name: string, run: () => Promise<A>) =>
		Effect.tryPromise({
			try: run,
			catch: (cause) =>
				new DatabaseError({ query: name, reason: 'query_failed', cause }),
		})

	const decodeRow = <Row>(query: D1RowQuery<Row>, row: unknown) =>
		Schema.decodeUnknownEffect(query.row)(row).pipe(
			Effect.mapError(
				(cause) =>
					new DatabaseError({ query: query.name, reason: 'row_shape', cause }),
			),
		)

	return D1.of({
		first: <Row>(query: D1RowQuery<Row>) =>
			execute(query.name, () => prepare(query).first()).pipe(
				Effect.flatMap((row) =>
					row === null
						? Effect.succeedNone
						: decodeRow(query, row).pipe(Effect.map(Option.some)),
				),
				Effect.withSpan('D1.first', { attributes: { 'db.query': query.name } }),
			),
		all: <Row>(query: D1RowQuery<Row>) =>
			execute(query.name, () => prepare(query).all()).pipe(
				Effect.flatMap(({ results }) =>
					Effect.forEach(results, (row) => decodeRow(query, row)),
				),
				Effect.withSpan('D1.all', { attributes: { 'db.query': query.name } }),
			),
		run: (query) =>
			execute(query.name, () => prepare(query).run()).pipe(
				Effect.map(({ meta }) => ({ changes: meta.changes })),
				Effect.withSpan('D1.run', { attributes: { 'db.query': query.name } }),
			),
		batch: (name, queries) =>
			execute(name, () => db.batch(queries.map(prepare))).pipe(
				Effect.map((results) =>
					results.map(({ meta }) => ({ changes: meta?.changes ?? 0 })),
				),
				Effect.withSpan('D1.batch', { attributes: { 'db.query': name } }),
			),
	})
}

/**
 * One scripted failure source for {@link withD1Failures}. Each execution of a
 * matching statement (or batch) throws the next message in `errors` until the
 * list is empty, then runs normally.
 */
export type D1FailureRule = {
	matches: (query: string, params: ReadonlyArray<unknown>) => boolean
	errors: Array<string>
}

/**
 * Wrap a test D1 binding so scripted statements throw D1-shaped errors before
 * reaching SQLite. `executions` records every statement and batch run, so a
 * test can count attempts. A batch matches on its statements' queries joined
 * with `;` and all of their bound params.
 */
export function withD1Failures(
	db: D1Database,
	rules: Array<D1FailureRule>,
	executions: Array<string> = [],
): D1Database {
	const rawStatements = new WeakMap<object, D1PreparedStatement>()
	const queries = new WeakMap<object, string>()
	const boundParams = new WeakMap<object, ReadonlyArray<unknown>>()

	function failIfScripted(query: string, params: ReadonlyArray<unknown>) {
		executions.push(query)
		const rule = rules.find(
			(candidate) =>
				candidate.errors.length > 0 && candidate.matches(query, params),
		)
		const message = rule?.errors.shift()
		if (message !== undefined) throw new Error(message)
	}

	function statement(
		raw: D1PreparedStatement,
		query: string,
		params: ReadonlyArray<unknown>,
	): D1PreparedStatement {
		const wrapped = {
			bind: (...values: Array<unknown>) =>
				statement(raw.bind(...values), query, values),
			first: async (...args: Array<unknown>) => {
				failIfScripted(query, params)
				return (raw.first as (...a: Array<unknown>) => unknown)(...args)
			},
			run: async () => {
				failIfScripted(query, params)
				return raw.run()
			},
			all: async () => {
				failIfScripted(query, params)
				return raw.all()
			},
			raw: async (...args: Array<unknown>) => {
				failIfScripted(query, params)
				return (raw.raw as (...a: Array<unknown>) => unknown)(...args)
			},
		} as unknown as D1PreparedStatement
		rawStatements.set(wrapped, raw)
		queries.set(wrapped, query)
		boundParams.set(wrapped, params)
		return wrapped
	}

	return {
		...db,
		prepare: (query: string) => statement(db.prepare(query), query, []),
		batch: async (statements: Array<D1PreparedStatement>) => {
			failIfScripted(
				statements.map((entry) => queries.get(entry) ?? '').join(';'),
				statements.flatMap((entry) => boundParams.get(entry) ?? []),
			)
			return db.batch(
				statements.map((entry) => rawStatements.get(entry) ?? entry),
			)
		},
	} as D1Database
}

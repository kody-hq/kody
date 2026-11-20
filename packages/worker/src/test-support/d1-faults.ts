export const transientD1Error = () =>
	new Error('D1_ERROR: Network connection lost.')

/**
 * Wraps a test D1 so `fault(sql, params)` can fail an attempt of `first`,
 * `run`, or `all`; it is asked again on every attempt. Batches pass through.
 */
export function withD1Faults(
	db: D1Database,
	fault: (sql: string, params: Array<unknown>) => Error | null,
): D1Database {
	const originals = new WeakMap<object, D1PreparedStatement>()
	const wrap = (
		statement: D1PreparedStatement,
		sql: string,
		params: Array<unknown>,
	): D1PreparedStatement => {
		const call =
			(method: 'first' | 'run' | 'all') =>
			async (...args: Array<unknown>) => {
				const error = fault(sql, params)
				if (error) throw error
				return Reflect.apply(statement[method], statement, args)
			}
		const wrapped = {
			bind: (...values: Array<unknown>) =>
				wrap(statement.bind(...values), sql, values),
			first: call('first'),
			run: call('run'),
			all: call('all'),
			raw: (...args: Array<unknown>) =>
				Reflect.apply(statement.raw, statement, args),
		} as unknown as D1PreparedStatement
		originals.set(wrapped, statement)
		return wrapped
	}
	return {
		prepare: (sql: string) => wrap(db.prepare(sql), sql, []),
		batch: (statements: Array<D1PreparedStatement>) =>
			db.batch(statements.map((s) => originals.get(s) ?? s)),
		exec: (sql: string) => db.exec(sql),
	} as unknown as D1Database
}

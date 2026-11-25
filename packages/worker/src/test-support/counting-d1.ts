/**
 * Wrap a D1 binding so every executed statement is recorded. A statement
 * counts once per `first` / `all` / `run` / `raw`, and every statement inside
 * a `batch` counts on its own. Used to assert how many D1 round trips a
 * request pays.
 */
export type CountingD1 = {
	db: D1Database
	statements: Array<string>
	reset: () => void
}

const statementSql = new WeakMap<object, { sql: string; real: object }>()

function normalizeSql(sql: string) {
	return sql.replace(/\s+/g, ' ').trim()
}

export function createCountingD1(real: D1Database): CountingD1 {
	const statements: Array<string> = []

	function wrapStatement(
		realStatement: D1PreparedStatement,
		sql: string,
	): D1PreparedStatement {
		const executed =
			<Method extends 'first' | 'all' | 'run' | 'raw'>(method: Method) =>
			(...args: Array<unknown>) => {
				statements.push(sql)
				const call = realStatement[method] as (
					...methodArgs: Array<unknown>
				) => unknown
				return call.apply(realStatement, args)
			}
		const wrapped = {
			bind: (...values: Array<unknown>) =>
				wrapStatement(realStatement.bind(...values), sql),
			first: executed('first'),
			all: executed('all'),
			run: executed('run'),
			raw: executed('raw'),
		} as unknown as D1PreparedStatement
		statementSql.set(wrapped, { sql, real: realStatement })
		return wrapped
	}

	// Bind the real methods up front. Instrumentation (Sentry) patches
	// `prepare` on whatever binding it sees; reading through to `real` later
	// would call that patch, which calls back into this wrapper.
	const realPrepare = real.prepare.bind(real)
	const realBatch = real.batch.bind(real)
	const realExec = real.exec.bind(real)
	const db = {
		prepare(sql: string) {
			return wrapStatement(realPrepare(sql), normalizeSql(sql))
		},
		batch(batch: Array<D1PreparedStatement>) {
			const unwrapped = batch.map((statement) => {
				const recorded = statementSql.get(statement)
				statements.push(recorded?.sql ?? '<unknown>')
				return (recorded?.real ?? statement) as D1PreparedStatement
			})
			return realBatch(unwrapped)
		},
		exec(sql: string) {
			statements.push(normalizeSql(sql))
			return realExec(sql)
		},
		dump() {
			return real.dump()
		},
		withSession(constraint?: string) {
			return real.withSession(constraint)
		},
	} as unknown as D1Database

	return {
		db,
		statements,
		reset() {
			statements.length = 0
		},
	}
}

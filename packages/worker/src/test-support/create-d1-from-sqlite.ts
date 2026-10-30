import { type DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type CreateD1FromSqliteOptions = {
	/**
	 * When set, `bind(...params)` throws if `params.length` exceeds the limit
	 * (used to exercise D1 binding-count constraints in tests).
	 */
	maxBindings?: number
	/** Invoked with the row count whenever `all()` returns results. */
	onQueryRows?: (rowCount: number) => void
	/**
	 * When provided, each prepared query is appended after whitespace
	 * normalization (useful for asserting which SQL a code path issues).
	 */
	queries?: Array<string>
}

type StatementRunner = {
	run: () => Promise<unknown>
}

/**
 * Thin D1Database facade over `node:sqlite` `DatabaseSync` for `*.node.test.ts`
 * suites that need SQL without Cloudflare Workers bindings.
 *
 * Prefer importing this over copy-pasting a local helper. Pass options only when
 * a test needs query capture, binding limits, or row-count hooks.
 *
 * Overlapping `batch()` calls are serialized (mutex) to match production D1,
 * which queues concurrent batches instead of nesting transactions (#3634).
 */
export function createD1FromSqlite(
	db: DatabaseSync,
	options: CreateD1FromSqliteOptions = {},
): D1Database {
	let batchTail: Promise<unknown> = Promise.resolve()

	function assertBindingCount(params: Array<unknown>) {
		if (
			options.maxBindings !== undefined &&
			params.length > options.maxBindings
		) {
			throw new Error(`too many SQL variables: ${params.length}`)
		}
	}

	function createPreparedStatement(query: string) {
		return {
			query,
			// D1's `bind` accepts `unknown`; callers in tests pass SQLite-compatible
			// scalars, so narrow once here for `node:sqlite`'s typed statements.
			bind(...params: Array<SQLInputValue>) {
				assertBindingCount(params)
				return {
					query,
					async all<T>() {
						const statement = db.prepare(query)
						const rows = statement.all(...params) as Array<T>
						options.onQueryRows?.(rows.length)
						return {
							results: rows,
							meta: { changes: 0, last_row_id: 0 },
						}
					},
					async first<T>() {
						const statement = db.prepare(query)
						return (statement.get(...params) ?? null) as T | null
					},
					async run() {
						const statement = db.prepare(query)
						const result = statement.run(...params)
						return {
							meta: {
								changes: result.changes,
								last_row_id: Number(result.lastInsertRowid),
							},
						}
					},
				}
			},
			async all<T>() {
				const statement = db.prepare(query)
				const rows = statement.all() as Array<T>
				options.onQueryRows?.(rows.length)
				return {
					results: rows,
					meta: { changes: 0, last_row_id: 0 },
				}
			},
			async first<T>() {
				const statement = db.prepare(query)
				return (statement.get() ?? null) as T | null
			},
			async run() {
				const statement = db.prepare(query)
				const result = statement.run()
				return {
					meta: {
						changes: result.changes,
						last_row_id: Number(result.lastInsertRowid),
					},
				}
			},
		}
	}

	async function runBatch(
		statements: Array<
			StatementRunner & { all?: () => Promise<unknown>; query?: string }
		>,
	) {
		const results = []
		db.exec('BEGIN')
		try {
			for (const statement of statements) {
				const query = statement.query ?? ''
				if (
					typeof statement.all === 'function' &&
					/^\s*select\b/i.test(query)
				) {
					results.push(await statement.all())
				} else if (
					typeof statement.all === 'function' &&
					/\breturning\b/i.test(query)
				) {
					const result = (await statement.all()) as { results: Array<unknown> }
					results.push({
						...result,
						meta: { changes: result.results.length, last_row_id: 0 },
					})
				} else {
					results.push(await statement.run())
				}
			}
			db.exec('COMMIT')
			return results
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	return {
		prepare(query: string) {
			options.queries?.push(query.replace(/\s+/g, ' ').trim())
			return createPreparedStatement(query)
		},
		async batch(
			statements: Array<
				StatementRunner & { all?: () => Promise<unknown>; query?: string }
			>,
		) {
			const run = batchTail.then(
				() => runBatch(statements),
				() => runBatch(statements),
			)
			// Keep the chain alive without retaining a rejected reason.
			batchTail = run.then(
				() => undefined,
				() => undefined,
			)
			return run
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

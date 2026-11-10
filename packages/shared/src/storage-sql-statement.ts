/**
 * SQL statement classification shared by the hosted StorageRunner and the
 * CLI mock target so both pick the same cursor policy for a statement.
 */

/** Response row cap for `storage.sql` / `packageStorage().sql`. */
export const maxStorageSqlQueryRows = 1_000

/** Coerce caller bindings to the values `ctx.storage.sql.exec` accepts. */
export function normalizeSqlParams(params: Array<unknown> | undefined) {
	return (params ?? []).map((value) => {
		if (
			value === null ||
			typeof value === 'string' ||
			typeof value === 'number'
		) {
			return value
		}
		if (typeof value === 'boolean') {
			return value ? 1 : 0
		}
		throw new Error(
			'storage.sql params only support strings, numbers, booleans, and null.',
		)
	})
}

const storageSqlReturningMutationVerbs = [
	'insert',
	'update',
	'delete',
	'replace',
] as const

const storageSqlWriteVerbs = [
	...storageSqlReturningMutationVerbs,
	'create',
	'drop',
	'alter',
] as const

const storageSqlReturningMutationVerbInWithPattern =
	/(?:^|[^a-z0-9_])(?:insert|update|delete|replace)(?:[^a-z0-9_]|$)/

/**
 * Replace comments and quoted literals with spaces so verb checks cannot see
 * words inside strings, identifiers, or comments.
 */
export function maskSqlLiteralsAndComments(query: string) {
	let masked = ''
	let inSingleQuote = false
	let inDoubleQuote = false
	let inBacktickQuote = false
	let inBracketQuote = false
	let inLineComment = false
	let inBlockComment = false

	for (let index = 0; index < query.length; index += 1) {
		const current = query.charAt(index)
		const next = query.charAt(index + 1)

		if (inLineComment) {
			masked += current === '\n' ? '\n' : ' '
			if (current === '\n') inLineComment = false
			continue
		}
		if (inBlockComment) {
			masked += ' '
			if (current === '*' && next === '/') {
				inBlockComment = false
				masked += ' '
				index += 1
			}
			continue
		}
		if (inSingleQuote) {
			masked += ' '
			if (current === "'" && next === "'") {
				masked += ' '
				index += 1
				continue
			}
			if (current === "'") inSingleQuote = false
			continue
		}
		if (inDoubleQuote) {
			masked += ' '
			if (current === '"' && next === '"') {
				masked += ' '
				index += 1
				continue
			}
			if (current === '"') inDoubleQuote = false
			continue
		}
		if (inBacktickQuote) {
			masked += ' '
			if (current === '`') inBacktickQuote = false
			continue
		}
		if (inBracketQuote) {
			masked += ' '
			if (current === ']') inBracketQuote = false
			continue
		}
		if (current === '-' && next === '-') {
			inLineComment = true
			masked += '  '
			index += 1
			continue
		}
		if (current === '/' && next === '*') {
			inBlockComment = true
			masked += '  '
			index += 1
			continue
		}
		if (current === "'") {
			inSingleQuote = true
			masked += ' '
			continue
		}
		if (current === '"') {
			inDoubleQuote = true
			masked += ' '
			continue
		}
		if (current === '`') {
			inBacktickQuote = true
			masked += ' '
			continue
		}
		if (current === '[') {
			inBracketQuote = true
			masked += ' '
			continue
		}
		masked += current
	}

	return masked
}

function sqlStartsWithVerb(normalized: string, verbs: ReadonlyArray<string>) {
	for (const verb of verbs) {
		if (normalized.startsWith(verb)) return true
	}
	return false
}

/**
 * True when `query` can mutate while yielding rows (SQLite RETURNING on
 * INSERT / UPDATE / DELETE / REPLACE, including after a WITH clause).
 *
 * Used by {@link collectStorageSqlCursor} drainOverflow: only these statements must
 * keep stepping past the row cap so the write finishes. Pure reads, including
 * `WITH … SELECT` sent with `writable: true` from packageStorage, stop early.
 * Words inside strings, identifiers, and comments are ignored.
 */
export function isStorageSqlReturningMutation(query: string) {
	const normalized = maskSqlLiteralsAndComments(query).trim().toLowerCase()
	if (!normalized) return false
	if (sqlStartsWithVerb(normalized, storageSqlReturningMutationVerbs)) {
		return true
	}
	if (!normalized.startsWith('with')) return false
	return storageSqlReturningMutationVerbInWithPattern.test(normalized)
}

/**
 * True when the statement can change the bucket, including DDL such as
 * `CREATE TABLE AS SELECT`. Unlike {@link isStorageSqlReturningMutation}, this
 * does not require a row-yielding DML verb. Quoted words do not count.
 * After `WITH`, only INSERT / UPDATE / DELETE / REPLACE count: SQLite does
 * not allow CREATE / DROP / ALTER there, so those tokens are identifiers.
 */
export function isStorageSqlWrite(query: string) {
	const normalized = maskSqlLiteralsAndComments(query).trim().toLowerCase()
	if (!normalized) return false
	if (sqlStartsWithVerb(normalized, storageSqlWriteVerbs)) return true
	if (!normalized.startsWith('with')) return false
	return storageSqlReturningMutationVerbInWithPattern.test(normalized)
}

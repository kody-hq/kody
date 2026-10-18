/**
 * Scratch storage for `--target mock`, keyed by the active content-addressed
 * session directory under the user cache. Reset with `--reset-storage`.
 */

import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { userCacheDir } from '../workerd-binary.js'

export type MockStorageBucket = {
	/** Arbitrary JSON-serializable rows keyed by string id. */
	rows: Record<string, unknown>
}

export type MockSessionState = {
	version: 1
	sessionId: string
	createdAt: string
	updatedAt: string
	/** packageId → bucket */
	packageStorage: Record<string, MockStorageBucket>
	/** Fake / local credential metadata only — never real secret values from prod. */
	credentials: Record<
		string,
		{
			id: string
			name: string
			kind: 'secret' | 'oauth'
			/** Host allow-list for credential().fetch (ADR 0068 client shape). */
			hosts: Array<string>
			scope?: 'personal' | 'org'
			/** Placeholder value used only inside the mock. */
			mockValue: string
		}
	>
	/** Soft catalog entries surfaced by mock search. */
	searchCatalog: Array<{
		type: string
		id: string
		title: string
		description: string
	}>
}

const mockStateFile = 'state.json'

export function mockSessionRoot(
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(userCacheDir(env), 'mock-sessions', sessionId)
}

export function defaultMockSessionId(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.KODY_MOCK_SESSION_ID?.trim() || 'default'
}

export async function loadMockSession(input: {
	sessionId?: string
	env?: NodeJS.ProcessEnv
	reset?: boolean
}): Promise<MockSessionState> {
	const env = input.env ?? process.env
	const sessionId = input.sessionId ?? defaultMockSessionId(env)
	const root = mockSessionRoot(sessionId, env)
	if (input.reset) {
		await rm(root, { recursive: true, force: true })
	}
	await mkdir(root, { recursive: true })
	const path = join(root, mockStateFile)
	try {
		const raw = JSON.parse(await readFile(path, 'utf8')) as MockSessionState
		if (raw?.version === 1 && raw.sessionId === sessionId) {
			return normalizeMockSessionCredentials(raw)
		}
	} catch {
		// miss → create
	}
	const now = new Date().toISOString()
	const fresh: MockSessionState = {
		version: 1,
		sessionId,
		createdAt: now,
		updatedAt: now,
		packageStorage: {},
		credentials: {
			MOCK_SECRET: {
				id: 'cred_mock_secret',
				name: 'MOCK_SECRET',
				kind: 'secret',
				hosts: ['example.com'],
				scope: 'personal',
				mockValue: 'mock-secret-value',
			},
		},
		searchCatalog: [
			{
				type: 'guide',
				id: 'local_execute',
				title: 'Local CLI execute',
				description: 'Prefer @kodycodes/cli execute --local when Node ≥22.',
			},
			{
				type: 'capability',
				id: 'metaGetCurrentUser',
				title: 'metaGetCurrentUser',
				description: 'Return the current authenticated user and org binding.',
			},
			{
				type: 'guide',
				id: 'package_apps',
				title: 'Package apps',
				description:
					'Hosted Worker apps on *.kody.run; use kody dev for local.',
			},
		],
	}
	await persistMockSession(fresh, env)
	return fresh
}

export async function persistMockSession(
	state: MockSessionState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	state.updatedAt = new Date().toISOString()
	const root = mockSessionRoot(state.sessionId, env)
	await mkdir(root, { recursive: true })
	await writeFile(
		join(root, mockStateFile),
		`${JSON.stringify(state, null, 2)}\n`,
	)
}

/** Backfill hosts/scope on older mock session files so credential() stays iterable. */
function normalizeMockSessionCredentials(
	state: MockSessionState,
): MockSessionState {
	const credentials: MockSessionState['credentials'] = {}
	for (const [key, cred] of Object.entries(state.credentials ?? {})) {
		credentials[key] = {
			...cred,
			hosts:
				Array.isArray(cred.hosts) && cred.hosts.length > 0
					? cred.hosts
					: ['example.com'],
			scope: cred.scope === 'org' ? 'org' : 'personal',
		}
	}
	if (!credentials.MOCK_SECRET) {
		credentials.MOCK_SECRET = {
			id: 'cred_mock_secret',
			name: 'MOCK_SECRET',
			kind: 'secret',
			hosts: ['example.com'],
			scope: 'personal',
			mockValue: 'mock-secret-value',
		}
	}
	state.credentials = credentials
	return state
}

export function packageStorageGet(
	state: MockSessionState,
	packageId: string,
	key: string,
): unknown {
	return state.packageStorage[packageId]?.rows[key]
}

export function packageStorageSet(
	state: MockSessionState,
	packageId: string,
	key: string,
	value: unknown,
): void {
	const bucket = (state.packageStorage[packageId] ??= { rows: {} })
	bucket.rows[key] = value
}

export function packageStorageDelete(
	state: MockSessionState,
	packageId: string,
	key: string,
): boolean {
	const bucket = state.packageStorage[packageId]
	if (!bucket || !(key in bucket.rows)) return false
	delete bucket.rows[key]
	return true
}

export function packageStorageList(
	state: MockSessionState,
	packageId: string,
): Array<{ key: string; value: unknown }> {
	const rows = state.packageStorage[packageId]?.rows ?? {}
	return Object.entries(rows).map(([key, value]) => ({ key, value }))
}

const openSqlDbs = new Map<string, DatabaseSync>()

function packageSqlDbPath(
	state: MockSessionState,
	packageId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const safe = packageId.replace(/[^a-zA-Z0-9._-]+/g, '_')
	const dir = join(mockSessionRoot(state.sessionId, env), 'sqlite')
	mkdirSync(dir, { recursive: true })
	return join(dir, `${safe || 'package'}.sqlite`)
}

function openPackageSqlDb(
	state: MockSessionState,
	packageId: string,
	env: NodeJS.ProcessEnv = process.env,
): DatabaseSync {
	const path = packageSqlDbPath(state, packageId, env)
	const cacheKey = `${state.sessionId}:${path}`
	const existing = openSqlDbs.get(cacheKey)
	if (existing) return existing
	const db = new DatabaseSync(path)
	openSqlDbs.set(cacheKey, db)
	return db
}

/** Close cached SQLite handles for a session (after --reset-storage). */
export function closePackageSqlDbsForSession(sessionId: string): void {
	for (const [key, db] of openSqlDbs) {
		if (!key.startsWith(`${sessionId}:`)) continue
		try {
			db.close()
		} catch {
			// already closed
		}
		openSqlDbs.delete(key)
	}
}

/**
 * True when the prepared statement yields result columns (SELECT / WITH /
 * PRAGMA / EXPLAIN, or DML with RETURNING). Prefer `StatementSync.columns()`
 * (Node ≥22.16) over verb-prefix matching so `INSERT … RETURNING` is not
 * treated as a silent mutation. A `returning` regex would also match string
 * literals — columns() does not.
 */
export function statementYieldsRows(stmt: {
	columns?: () => Array<unknown>
}): boolean | null {
	if (typeof stmt.columns !== 'function') return null
	return stmt.columns().length > 0
}

/**
 * Run SQL against the package's scratch SQLite file.
 * Returns `{ rows }` so callers that accept either an array or `{ rows }` work
 * (same shape dropbox-delete-me / data-table expect from hosted packageStorage).
 * Mutations without result columns also return `changes` (node:sqlite `run`).
 * Hosted `packageStorage().sql` returns RETURNING rows the same way via the
 * Durable Object SQL cursor (see storage-runner `sqlQuery`).
 */
export function packageStorageSql(
	state: MockSessionState,
	packageId: string,
	query: string,
	bindings: Array<unknown> = [],
	env: NodeJS.ProcessEnv = process.env,
): { rows: Array<Record<string, unknown>>; changes?: number } {
	const db = openPackageSqlDb(state, packageId, env)
	const stmt = db.prepare(query)
	const params: Array<null | number | bigint | string | Uint8Array> =
		bindings.map((value) => {
			if (value === null) return null
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'bigint'
			) {
				return value
			}
			if (typeof value === 'boolean') return value ? 1 : 0
			if (value instanceof Uint8Array) return value
			return String(value)
		})
	const yields = statementYieldsRows(stmt)
	if (yields === true) {
		return { rows: plainSqlRows(stmt.all(...params)) }
	}
	if (yields === false) {
		const info = stmt.run(...params) as { changes?: number }
		return {
			rows: [],
			changes: typeof info.changes === 'number' ? info.changes : 0,
		}
	}
	// Node < 22.16: columns() missing. Prefer all() so RETURNING still works.
	// all() already ran the statement — do not call run() afterward.
	const rows = plainSqlRows(stmt.all(...params))
	if (rows.length > 0) return { rows }
	const trimmed = query.trimStart().toLowerCase()
	const isReadLike =
		trimmed.startsWith('select') ||
		trimmed.startsWith('with') ||
		trimmed.startsWith('pragma') ||
		trimmed.startsWith('explain')
	if (isReadLike) return { rows }
	// Empty DML+RETURNING must match hosted `{ rows: [] }` (no `changes`).
	// Strip string/blob literals first so a body value of "returning id" does
	// not fake a RETURNING clause.
	if (sqlHasReturningClause(query)) return { rows }
	const changesRow = db.prepare('select changes() as c').get() as
		| { c?: number }
		| undefined
	return {
		rows: [],
		changes: typeof changesRow?.c === 'number' ? changesRow.c : 0,
	}
}

/** True when SQL has a RETURNING keyword outside string/blob literals. */
export function sqlHasReturningClause(query: string): boolean {
	const withoutLiterals = query.replace(
		/'(?:[^']|'')*'|"(?:[^"]|"")*"|X'[0-9A-Fa-f]*'/g,
		"''",
	)
	return /\breturning\b/i.test(withoutLiterals)
}

/** node:sqlite returns null-prototype row objects; plain clones JSON-cleanly. */
function plainSqlRows(rows: Array<unknown>): Array<Record<string, unknown>> {
	return rows.map((row) => ({ ...(row as Record<string, unknown>) }))
}

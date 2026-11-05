/**
 * Scratch storage for `--target mock`, keyed by the active content-addressed
 * session directory under the user cache. Reset with `--reset-storage`.
 */

import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { userCacheDir } from '../workerd-binary.js'

type MockStorageBucket = {
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

function mockSessionRoot(
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
	const existing = await readMockStateFile(join(root, mockStateFile), sessionId)
	if (existing) return existing
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
	const path = join(root, mockStateFile)
	// Write then rename so a reader in another process never sees half a file.
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`)
	await rename(temp, path)
}

/**
 * The mock store file is the source of truth, not any one process's memory:
 * `kody dev`, `kody execute --target mock`, one-shot `kody dev job|webhook|emit`,
 * and hand edits all share it. Refuses (never overwrites) a file it cannot read.
 */
export class MockStoreFileError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'MockStoreFileError'
	}
}

async function readMockStateFile(
	path: string,
	sessionId: string,
): Promise<MockSessionState | null> {
	for (let attempt = 0; ; attempt++) {
		let text: string
		try {
			text = await readFile(path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
		let raw: MockSessionState
		try {
			raw = JSON.parse(text) as MockSessionState
		} catch (error) {
			// An editor saving in place can leave a half-written file for a moment.
			if (attempt === 0) {
				await sleep(50)
				continue
			}
			throw new MockStoreFileError(
				`The mock store ${path} is not valid JSON (${(error as Error).message}), so Kody will not read or overwrite it. Fix the JSON, or delete the file (or pass --reset-storage) to start with empty mock storage.`,
			)
		}
		if (raw?.version !== 1 || raw.sessionId !== sessionId) {
			throw new MockStoreFileError(
				`The mock store ${path} is not a version 1 store for mock session "${sessionId}", so Kody will not read or overwrite it. Restore its "version": 1 and "sessionId": "${sessionId}", or delete the file (or pass --reset-storage) to start with empty mock storage.`,
			)
		}
		return normalizeMockSessionCredentials(raw)
	}
}

const mockStoreLockWaitMs = 5_000
const mockStoreStaleLockMs = 10_000

async function withMockStoreLock<T>(
	path: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = `${path}.lock`
	const deadline = Date.now() + mockStoreLockWaitMs
	for (;;) {
		try {
			await (await open(lockPath, 'wx')).close()
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			const heldMs = await stat(lockPath).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			)
			// A process that died mid-write leaves its lock behind.
			if (heldMs > mockStoreStaleLockMs) {
				await rm(lockPath, { force: true })
				continue
			}
			if (Date.now() > deadline) {
				throw new MockStoreFileError(
					`Another kody process has held the mock store lock ${lockPath} for over ${mockStoreLockWaitMs / 1000}s. If no other kody command is running, delete that file and retry.`,
				)
			}
			await sleep(10)
		}
	}
	try {
		return await fn()
	} finally {
		await rm(lockPath, { force: true })
	}
}

/** The current mock store, read fresh so writes from other processes show. */
export async function readMockSession(input: {
	sessionId: string
	env?: NodeJS.ProcessEnv
}): Promise<MockSessionState> {
	const env = input.env ?? process.env
	const path = join(mockSessionRoot(input.sessionId, env), mockStateFile)
	return (
		(await readMockStateFile(path, input.sessionId)) ??
		(await loadMockSession({ sessionId: input.sessionId, env }))
	)
}

/**
 * Apply one change to the latest store on disk under a cross-process lock,
 * so concurrent writers each keep their keys (last write wins per key).
 */
export async function mutateMockSession<T>(
	input: { sessionId: string; env?: NodeJS.ProcessEnv },
	change: (state: MockSessionState) => T,
): Promise<T> {
	const env = input.env ?? process.env
	const root = mockSessionRoot(input.sessionId, env)
	await mkdir(root, { recursive: true })
	const path = join(root, mockStateFile)
	return await withMockStoreLock(path, async () => {
		const state = await readMockSession({ sessionId: input.sessionId, env })
		const result = change(state)
		await persistMockSession(state, env)
		return result
	})
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

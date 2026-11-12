/**
 * Scratch storage for `--target mock`, keyed by the mock session id
 * (`KODY_MOCK_SESSION_ID`, or `default`) under the user cache
 * (`mock-sessions/<id>/`). Reset with `--reset-storage`.
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
import {
	DatabaseSync,
	type SQLInputValue,
	type StatementSync,
} from 'node:sqlite'
import {
	collectStorageSqlCursor,
	settleStorageSqlRead,
	type StorageSqlReadCursor,
	type StorageSqlReadResult,
	type StorageSqlReadValue,
} from '@kody-internal/shared/storage-sql-read-policy.ts'
import {
	isStorageSqlReturningMutation,
	isStorageSqlWrite,
	maskSqlLiteralsAndComments,
	maxStorageSqlQueryRows,
	normalizeSqlParams,
} from '@kody-internal/shared/storage-sql-statement.ts'
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

async function persistMockSession(
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
 * Run SQL against the package's scratch SQLite file and return the hosted
 * `packageStorage().sql` result. Shaping, the row cap, `truncated`, and the
 * rows-read warning come from the same helpers StorageRunner uses, so only
 * the cursor counters differ (see {@link mockSqlCursor}).
 *
 * Like `ctx.storage.sql.exec`, several `;`-separated statements run in order,
 * only the last may take bindings, and the result describes the last one.
 */
export function packageStorageSql(
	state: MockSessionState,
	packageId: string,
	query: string,
	bindings: Array<unknown> = [],
	env: NodeJS.ProcessEnv = process.env,
): StorageSqlReadResult {
	const db = openPackageSqlDb(state, packageId, env)
	const params: Array<SQLInputValue> = normalizeSqlParams(bindings)
	if (params.length > mockSqlMaxBoundParameters) {
		// Hosted Durable Object SQLite rejects these; fail locally the same way.
		throw new Error(
			`too many SQL variables: packageStorage().sql allows at most ${mockSqlMaxBoundParameters} bound parameters per statement (got ${params.length}). Split the batch.`,
		)
	}
	let remaining = query
	for (;;) {
		const stmt = prepareMockSqlStatement(db, remaining)
		const tail = remaining.slice(stmt.sourceSQL.length)
		const slots = sqlParameterSlots(stmt.sourceSQL)
		if (tail.trim()) {
			if (slots.length > 0) {
				throw new Error(
					'When executing multiple SQL statements in a single call, only the last statement can have parameters.',
				)
			}
			drainMockSqlStatement(stmt)
			remaining = tail
			continue
		}
		if (slots.length !== params.length) {
			throw new Error('Wrong number of parameter bindings for SQL query.')
		}
		const settled = settleStorageSqlRead(
			collectStorageSqlCursor(
				mockSqlCursor(db, stmt, bindMockSqlParams(slots, params)),
				{
					drainOverflow: isStorageSqlReturningMutation(stmt.sourceSQL),
					writeFinished: isStorageSqlWrite(stmt.sourceSQL),
					maxRows: maxStorageSqlQueryRows,
				},
			),
		)
		if (settled.outcome === 'error') throw settled.error
		return settled.result
	}
}

/** Hosted package storage SQL's per-statement bound-parameter cap. */
export const mockSqlMaxBoundParameters = 100

function prepareMockSqlStatement(db: DatabaseSync, sql: string) {
	try {
		return db.prepare(sql)
	} catch (error) {
		// Match the workerd message for empty SQL or a trailing comment.
		if (
			error instanceof Error &&
			error.message.includes('contains no statements')
		) {
			throw new Error('SQL code did not contain a statement.')
		}
		throw error
	}
}

function drainMockSqlStatement(stmt: StatementSync) {
	for (const _row of runMockSqlStatement(stmt, [])) {
		// Earlier statements run for their side effects only.
	}
}

type SqlParameterSlot = { index: number; name: string | null }

/**
 * Parameter slots SQLite assigns to one statement (`?`, `?NNN`, `:name`,
 * `@name`, `$name`), in index order. node:sqlite does not expose
 * `sqlite3_bind_parameter_count`, and it silently binds NULL for missing
 * positional values where workerd throws, so the mock counts them itself.
 */
export function sqlParameterSlots(sql: string): Array<SqlParameterSlot> {
	const masked = maskSqlLiteralsAndComments(sql)
	const slots = new Map<number, SqlParameterSlot>()
	const named = new Map<string, number>()
	let maxIndex = 0
	const pattern = /\?(\d*)|[:@$]([A-Za-z_][A-Za-z0-9_]*)/g
	for (const match of masked.matchAll(pattern)) {
		const [, numbered, name] = match
		if (name !== undefined) {
			if (named.has(name)) continue
			maxIndex += 1
			named.set(name, maxIndex)
			slots.set(maxIndex, { index: maxIndex, name })
			continue
		}
		const index = numbered ? Number(numbered) : maxIndex + 1
		maxIndex = Math.max(maxIndex, index)
		if (!slots.has(index)) slots.set(index, { index, name: null })
	}
	return Array.from({ length: maxIndex }, (_, offset) => {
		const index = offset + 1
		return slots.get(index) ?? { index, name: null }
	})
}

type MockSqlArgs = [
	named: Record<string, SQLInputValue> | undefined,
	positional: Array<SQLInputValue>,
]

/**
 * Hosted binds params by position even for named parameters. node:sqlite
 * binds names from an object, so map each named slot to its positional value.
 */
function bindMockSqlParams(
	slots: Array<SqlParameterSlot>,
	params: Array<SQLInputValue>,
): MockSqlArgs {
	if (!slots.some((slot) => slot.name !== null)) return [undefined, params]
	const named: Record<string, SQLInputValue> = {}
	const positional: Array<SQLInputValue> = []
	for (const slot of slots) {
		const value = params[slot.index - 1] ?? null
		if (slot.name === null) positional.push(value)
		else named[slot.name] = value
	}
	return [named, positional]
}

/**
 * Adapt a node:sqlite statement to the cursor shape `collectStorageSqlCursor`
 * reads from a Durable Object `SqlStorageCursor`.
 *
 * Cloudflare's `rowsRead` / `rowsWritten` come from its own SQLite
 * instrumentation, which node:sqlite cannot read, so the mock estimates them:
 * - `rowsWritten` is `total_changes()` for the statement: rows inserted,
 *   updated, or deleted. Hosted also counts index entries and schema rows, so
 *   DDL reports 0 here and indexed tables report fewer writes.
 * - `rowsRead` is the larger of the rows returned and the rows stepped by
 *   full-table scans. Hosted also counts index probes, aggregate scans, and
 *   schema reads, but not rows a table-free SELECT or PRAGMA returns, so the
 *   mock usually reads low for tables and high for those. The
 *   1,000,000-row warning and the 1,000,000,000-row ceiling use this estimate.
 */
function mockSqlCursor(
	db: DatabaseSync,
	stmt: StatementSync,
	[named, positional]: MockSqlArgs,
): StorageSqlReadCursor {
	const changesBefore = totalSqlChanges(db)
	const args = named ? [named, ...positional] : positional
	const rows = runMockSqlStatement(stmt, args)
	let firstRow: Record<string, StorageSqlReadValue> | null = null
	let rowsReturned = 0
	let rowsWritten: number | null = null
	return {
		get columnNames() {
			return sqlColumnNames(stmt, firstRow)
		},
		get rowsRead() {
			return Math.max(rowsReturned, fullScanRows(stmt))
		},
		get rowsWritten() {
			return rowsWritten ?? totalSqlChanges(db) - changesBefore
		},
		*[Symbol.iterator]() {
			try {
				for (const raw of rows) {
					const row = plainSqlRow(raw)
					firstRow ??= row
					rowsReturned += 1
					yield row
				}
			} finally {
				rowsWritten = totalSqlChanges(db) - changesBefore
			}
		},
	}
}

type MockSqlStatementApi = {
	iterate?: (...args: Array<unknown>) => Iterable<unknown>
	all: (...args: Array<unknown>) => Array<unknown>
	columns?: () => Array<{ name: string }>
	stat?: (counter: string) => number | bigint
}

/** `iterate()` is Node 22.13+; older Node 22 materializes with `all()`. */
function runMockSqlStatement(
	stmt: StatementSync,
	args: Array<unknown>,
): Iterable<unknown> {
	const api = stmt as unknown as MockSqlStatementApi
	return typeof api.iterate === 'function'
		? api.iterate.apply(stmt, args)
		: api.all.apply(stmt, args)
}

/** `columns()` is Node 22.16+; before that only a returned row names them. */
function sqlColumnNames(
	stmt: StatementSync,
	firstRow: Record<string, StorageSqlReadValue> | null,
): Array<string> {
	const api = stmt as unknown as MockSqlStatementApi
	if (typeof api.columns === 'function') {
		return api.columns.call(stmt).map((column) => column.name)
	}
	return firstRow ? Object.keys(firstRow) : []
}

function totalSqlChanges(db: DatabaseSync): number {
	const row = db.prepare('select total_changes() as c').get() as
		| { c?: number | bigint }
		| undefined
	return Number(row?.c ?? 0)
}

/**
 * SQLite counts full-scan `Next` steps, one fewer than the rows visited.
 * `stat()` is missing on older Node, which leaves only returned rows.
 */
function fullScanRows(stmt: StatementSync): number {
	const api = stmt as unknown as MockSqlStatementApi
	if (typeof api.stat !== 'function') return 0
	const steps = Number(api.stat.call(stmt, 'fullscanStep'))
	return steps > 0 ? steps + 1 : 0
}

/** node:sqlite returns null-prototype row objects; plain clones JSON-cleanly. */
function plainSqlRow(row: unknown): Record<string, StorageSqlReadValue> {
	const out: Record<string, StorageSqlReadValue> = {}
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		out[key] = value as StorageSqlReadValue
	}
	return out
}

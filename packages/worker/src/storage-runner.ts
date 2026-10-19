import * as Sentry from '@sentry/cloudflare'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { DurableObject } from 'cloudflare:workers'
import { getRecoveryBookmark, restoreToBookmark } from '#worker/dr/do-pitr.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageSqlWriteBytes,
	readStorageBytesFromUserMeter,
} from '#worker/entitlements/service.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	formatStorageBucketKindSummary,
	listUserStorageBucketEstimates,
	maybeRefreshStorageBucketEstimate,
	recordStorageBucketEstimate,
	repoSessionIdFromStorageBucketId,
	registerStorageBucket,
	type StorageBucketKind,
	storageBucketKindFromStorageId,
} from '#worker/storage-buckets/service.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import {
	countStorageSqlRows,
	readStorageSqlRowsPage,
	readStorageSqlSchema,
	writeStorageSqlRows,
	writeStorageSqlSchema,
	type StorageSqlExec,
	type StorageSqlRowsPage,
	type StorageSqlSchemaObject,
	type StorageSqlValue as DumpSqlValue,
} from '#worker/storage-runner-sql-dump.ts'
import {
	buildPackageStorageId,
	packageIdFromStorageId,
} from '#worker/storage-ids.ts'
import { storageRunnerDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	collectStorageSqlCursor,
	settleStorageSqlRead,
	type StorageSqlReadCollection,
} from '#worker/storage-sql-read-policy.ts'
import { recordDurableObjectRowsRead } from '#worker/usage/durable-object-rows.ts'
import { createMeteredDurableObjectStub } from '#worker/usage/durable-object-usage.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { kodyCallDispatcherName } from '#worker/kody-evaluate-bindings.ts'

const defaultStorageExportPageSize = 250
const maxStorageExportPageSize = 1_000
/** Cap for StorageRunner sqlQuery row materialization (matches export max). */
export const maxStorageSqlQueryRows = maxStorageExportPageSize
const maxConcurrentStorageEstimateReads = 16
/**
 * Backoff pauses between estimate read attempts (attempts = length + 1).
 * Entitlement baselines only probe the write-target bucket plus any bucket
 * that has never been measured, so the probe set is small enough to afford
 * several attempts: production showed a single 150ms retry was not enough to
 * ride out transient per-bucket DO estimate-read *rejections*.
 *
 * A timeout does not start a second RPC to the same storageId. The underlying
 * stub call is not cancelled; a new call would queue behind it on the
 * single-threaded DO and turn a slow wake into four stacked timeouts.
 * Timed-out attempts keep waiting on the in-flight promise. Fast rejects
 * still open a new RPC after backoff.
 */
export const storageEstimateReadRetryDelaysMs = [150, 600, 2400] as const
/**
 * Bound each StorageRunner `getEstimatedBytes` wait so one hung DO cannot own
 * the whole sandbox deadline (~90s). Fail closed after this budget per
 * attempt; retries of a timed-out storageId reuse the same RPC.
 */
export const storageEstimateReadTimeoutMs = 2_000
/**
 * `ctx.storage.sql.databaseSize` for a never-written StorageRunner DO (one
 * SQLite page). Audit/entitlement callers that need a "has user data" signal
 * must compare against this floor rather than treating any positive size as
 * non-empty.
 */
export const emptyStorageRunnerEstimatedBytes = 4096

const readOnlyStorageSqlPrefixes = [
	'select',
	'explain',
	'pragma table_info(',
	'pragma index_list(',
	'pragma index_info(',
	'pragma database_list',
	'pragma table_list',
] as const

/**
 * Per-run memo for storage-byte entitlement totals. The first mutating write
 * in a sandbox pays the baseline read (D1 sums plus a live probe of the
 * target bucket and any buckets without a stored estimate); later writes
 * reuse that baseline and accumulate `reservedBytes` so the run still
 * accounts for its own earlier accepted writes without re-reading.
 */
export type StorageBytesEntitlementRunCache = {
	baseline: Promise<{
		bytes: number
		storageIds: ReadonlySet<string>
	}> | null
	reservedBytes: number
}

export function createStorageBytesEntitlementRunCache(): StorageBytesEntitlementRunCache {
	return {
		baseline: null,
		reservedBytes: 0,
	}
}

type StorageEntry = {
	key: string
	value: unknown
}

type StorageExportResult = {
	entries: Array<StorageEntry>
	estimatedBytes: number
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
}

type StorageSqlValue = string | number | null

type StorageListResult = StorageExportResult

type StorageSetResult = {
	ok: true
	key: string
}

type StorageDeleteResult = {
	ok: true
	key: string
	deleted: boolean
}

export type StorageClearResult = {
	ok: true
}

export type StorageEstimateResult = {
	estimatedBytes: number
}

/**
 * Paged replace protocol for StorageRunner restore:
 * - `replacePage: 'first'` clears the entire bucket, then writes entries
 *   (JSON-parsed from `valueJson`).
 * - `replacePage: 'continue'` upserts additional entries without clearing.
 * - Callers must send pages in order for a single replace session; sending
 *   `'first'` again restarts the replace (idempotent retry of page 1).
 * - Empty `'first'` pages are valid and leave the bucket empty.
 */
export async function applyImportStoragePage(
	storage: {
		deleteAll: () => Promise<void> | void
		put: (key: string, value: unknown) => Promise<void> | void
	},
	input: {
		mode: 'replace'
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; valueJson: string }>
	},
): Promise<{ ok: true; written: number; cleared: boolean }> {
	switch (input.mode) {
		case 'replace':
			break
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unsupported importStorage mode: ${String(exhaustive)}`)
		}
	}
	return await applyReplaceStoragePage(storage, {
		replacePage: input.replacePage,
		entries: input.entries.map((entry) => ({
			key: entry.key,
			read: () => {
				try {
					return JSON.parse(entry.valueJson) as unknown
				} catch {
					throw new Error(
						`importStorage received invalid valueJson for key ${normalizeStorageKey(entry.key)}`,
					)
				}
			},
		})),
	})
}

/**
 * Same replace protocol as {@link applyImportStoragePage}, but values arrive
 * already structured-cloned over RPC, so Dates, Maps, typed arrays, and other
 * cloneable values survive (JSON would flatten them).
 */
export async function applyImportStorageValuesPage(
	storage: {
		deleteAll: () => Promise<void> | void
		put: (key: string, value: unknown) => Promise<void> | void
	},
	input: {
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; value: unknown }>
	},
): Promise<{ ok: true; written: number; cleared: boolean }> {
	return await applyReplaceStoragePage(storage, {
		replacePage: input.replacePage,
		entries: input.entries.map((entry) => ({
			key: entry.key,
			read: () => entry.value,
		})),
	})
}

async function applyReplaceStoragePage(
	storage: {
		deleteAll: () => Promise<void> | void
		put: (key: string, value: unknown) => Promise<void> | void
	},
	input: {
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; read: () => unknown }>
	},
): Promise<{ ok: true; written: number; cleared: boolean }> {
	let cleared = false
	switch (input.replacePage) {
		case 'first': {
			await storage.deleteAll()
			cleared = true
			break
		}
		case 'continue':
			break
		default: {
			const exhaustive: never = input.replacePage
			throw new Error(
				`Unsupported importStorage replacePage: ${String(exhaustive)}`,
			)
		}
	}
	let written = 0
	for (const entry of input.entries) {
		const key = normalizeStorageKey(entry.key)
		await storage.put(key, entry.read())
		written += 1
	}
	return { ok: true, written, cleared }
}

export function createExecuteStorageId() {
	return `exec:${crypto.randomUUID()}`
}

export function createJobStorageId(jobId: string) {
	return `job:${jobId}`
}

function normalizeStorageKey(key: string) {
	const trimmed = key.trim()
	if (!trimmed) {
		throw new Error('Storage key must be a non-empty string.')
	}
	return trimmed
}

export const storageValueNotCloneableMessage =
	'Storage values must be structured-cloneable (plain objects, arrays, strings, numbers, booleans, null, and Dates). Proxies, functions, and other RPC-incompatible values cannot be stored.'

/**
 * Reject Proxies and other non-cloneable values on the host before the
 * StorageRunner RPC. Passing a runtime Proxy (`kody`, `email`, `events`,
 * or a metered stub) as a value otherwise fails at the DO boundary with
 * "Proxy could not be serialized because it is not a valid RPC receiver
 * type" and can make a later read of any key look broken.
 */
export function assertCloneableStorageValue(value: unknown) {
	try {
		structuredClone(value)
	} catch (error) {
		throw new Error(storageValueNotCloneableMessage, { cause: error })
	}
}

function readCloneableStorageValue(value: unknown) {
	if (value == null) return null
	try {
		return structuredClone(value)
	} catch (error) {
		throw new Error(storageValueNotCloneableMessage, { cause: error })
	}
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultStorageExportPageSize
	return Math.min(Math.max(requested, 1), maxStorageExportPageSize)
}

function normalizeSqlParams(params: Array<unknown> | undefined) {
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

function hasSqlContentAfterSemicolon(query: string, startIndex: number) {
	let inLineComment = false
	let inBlockComment = false

	for (let index = startIndex; index < query.length; index += 1) {
		const current = query.charAt(index)
		const next = query.charAt(index + 1)

		if (inLineComment) {
			if (current === '\n') {
				inLineComment = false
			}
			continue
		}

		if (inBlockComment) {
			if (current === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (current === '-' && next === '-') {
			inLineComment = true
			index += 1
			continue
		}

		if (current === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		if (!/\s/.test(current)) {
			return true
		}
	}

	return false
}

function hasMultipleSqlStatements(query: string) {
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
			if (current === '\n') {
				inLineComment = false
			}
			continue
		}

		if (inBlockComment) {
			if (current === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inSingleQuote) {
			if (current === "'" && next === "'") {
				index += 1
				continue
			}
			if (current === "'") {
				inSingleQuote = false
			}
			continue
		}

		if (inDoubleQuote) {
			if (current === '"' && next === '"') {
				index += 1
				continue
			}
			if (current === '"') {
				inDoubleQuote = false
			}
			continue
		}

		if (inBacktickQuote) {
			if (current === '`') {
				inBacktickQuote = false
			}
			continue
		}

		if (inBracketQuote) {
			if (current === ']') {
				inBracketQuote = false
			}
			continue
		}

		if (current === '-' && next === '-') {
			inLineComment = true
			index += 1
			continue
		}

		if (current === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		if (current === "'") {
			inSingleQuote = true
			continue
		}

		if (current === '"') {
			inDoubleQuote = true
			continue
		}

		if (current === '`') {
			inBacktickQuote = true
			continue
		}

		if (current === '[') {
			inBracketQuote = true
			continue
		}

		if (current === ';' && hasSqlContentAfterSemicolon(query, index + 1)) {
			return true
		}
	}

	return false
}

/**
 * True when `query` is a single SELECT / EXPLAIN / schema PRAGMA that the
 * read-only storage.sql contract accepts. Mutating SQL (and multi-statement
 * batches) return false even when the caller passed `writable: true`.
 *
 * Used to skip the all-bucket storage-byte entitlement fan-out on pure reads:
 * `packageStorage().sql(...)` always marks calls writable so CREATE/INSERT
 * work, but SELECT-heavy package exports were paying that fan-out on every
 * query and timing out under large bucket inventories.
 */
export function isReadOnlyStorageSqlQuery(query: string) {
	const trimmed = query.trim()
	if (!trimmed || hasMultipleSqlStatements(trimmed)) {
		return false
	}
	const normalized = trimmed.toLowerCase()
	return readOnlyStorageSqlPrefixes.some((prefix) =>
		normalized.startsWith(prefix),
	)
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
function maskSqlLiteralsAndComments(query: string) {
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
 * keep stepping past the row cap so the write finishes. Pure reads — including
 * `WITH … SELECT` sent with `writable: true` from packageStorage — stop early.
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

export const readOnlyStorageSqlDeniedMessage =
	'Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.'

export function assertStorageSqlAllowed(
	query: string,
	writable: boolean | undefined,
) {
	const trimmed = query.trim()
	if (!trimmed) {
		throw new Error('storage.sql requires a non-empty query.')
	}
	if (writable) return trimmed
	if (!isReadOnlyStorageSqlQuery(trimmed)) {
		throw new Error(readOnlyStorageSqlDeniedMessage)
	}
	return trimmed
}

async function withStorageEstimateReadTimeout<T>(
	read: () => Promise<T>,
	storageId: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			read(),
			new Promise<never>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(
						createStorageEstimateReadError({
							storageId,
							attempts: 1,
							cause: new Error(
								`Storage estimate read timed out after ${storageEstimateReadTimeoutMs}ms.`,
							),
						}),
					)
				}, storageEstimateReadTimeoutMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
	}
}

class StorageRunnerBase extends DurableObject<Env> {
	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'storage-runner',
			environment: this.env,
		})
	}

	async getValue(input: { key: string }) {
		const key = normalizeStorageKey(input.key)
		return {
			key,
			value: readCloneableStorageValue(await this.ctx.storage.get(key)),
		}
	}

	async setValue(input: {
		key: string
		value: unknown
	}): Promise<StorageSetResult> {
		const key = normalizeStorageKey(input.key)
		assertCloneableStorageValue(input.value)
		await this.ctx.storage.put(key, input.value)
		return { ok: true, key }
	}

	async deleteValue(input: { key: string }): Promise<StorageDeleteResult> {
		const key = normalizeStorageKey(input.key)
		const deleted = await this.ctx.storage.delete(key)
		return {
			ok: true,
			key,
			deleted,
		}
	}

	async clearStorage(): Promise<StorageClearResult> {
		await this.ctx.storage.deleteAll()
		return { ok: true }
	}

	async getEstimatedBytes(): Promise<StorageEstimateResult> {
		return { estimatedBytes: this.ctx.storage.sql.databaseSize }
	}

	async listValues(input: {
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}): Promise<StorageListResult> {
		const pageSize = normalizePageSize(input.pageSize)
		const prefix = input.prefix?.trim() || undefined
		const startAfter = input.startAfter?.trim() || undefined
		const listedEntries = await this.ctx.storage.list({
			...(prefix ? { prefix } : {}),
			...(startAfter ? { startAfter } : {}),
			limit: pageSize + 1,
		})
		const entries: Array<StorageEntry> = []
		let nextStartAfter: string | null = null
		let truncated = false
		for (const [key, value] of listedEntries) {
			if (entries.length === pageSize) {
				truncated = true
				break
			}
			entries.push({ key, value: readCloneableStorageValue(value) })
			nextStartAfter = key
		}
		return {
			entries,
			estimatedBytes: this.ctx.storage.sql.databaseSize,
			truncated,
			nextStartAfter: truncated ? nextStartAfter : null,
			pageSize,
		}
	}

	async exportStorage(input: {
		pageSize?: number
		startAfter?: string | null
	}) {
		return await this.listValues({
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	/**
	 * Paged restore counterpart of {@link exportStorage}.
	 * See {@link applyImportStoragePage} for the replace protocol.
	 */
	async importStorage(input: {
		mode: 'replace'
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; valueJson: string }>
	}): Promise<{
		ok: true
		written: number
		cleared: boolean
	}> {
		return await applyImportStoragePage(this.ctx.storage, input)
	}

	/** Owner-to-owner copy counterpart of {@link exportStorage}; lossless. */
	async importStorageValues(input: {
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; value: unknown }>
	}): Promise<{
		ok: true
		written: number
		cleared: boolean
	}> {
		return await applyImportStorageValuesPage(this.ctx.storage, input)
	}

	private readonly sqlExec: StorageSqlExec = (query, ...params) =>
		this.ctx.storage.sql.exec<Record<string, DumpSqlValue>>(query, ...params)

	async exportSqlSchema(): Promise<Array<StorageSqlSchemaObject>> {
		return readStorageSqlSchema(this.sqlExec)
	}

	async exportSqlRows(input: {
		table: string
		cursor: number | null
		pageSize?: number
	}): Promise<StorageSqlRowsPage> {
		return readStorageSqlRowsPage(this.sqlExec, input)
	}

	async importSqlSchema(input: {
		objects: Array<StorageSqlSchemaObject>
		phase: 'tables' | 'finish'
	}): Promise<{ ok: true }> {
		this.ctx.storage.transactionSync(() =>
			writeStorageSqlSchema(this.sqlExec, input),
		)
		return { ok: true }
	}

	async importSqlRows(input: {
		table: string
		columns: Array<string>
		rows: Array<Array<DumpSqlValue>>
	}): Promise<{ written: number }> {
		return {
			written: this.ctx.storage.transactionSync(() =>
				writeStorageSqlRows(this.sqlExec, input),
			),
		}
	}

	async countSqlRows(): Promise<Record<string, number>> {
		return countStorageSqlRows(this.sqlExec)
	}

	async sqlQuery(input: {
		query: string
		params?: Array<unknown>
		writable?: boolean
	}): Promise<StorageSqlReadCollection> {
		const query = assertStorageSqlAllowed(input.query, input.writable)
		const params = normalizeSqlParams(input.params)
		const cursor = this.ctx.storage.sql.exec<Record<string, StorageSqlValue>>(
			query,
			...params,
		)
		const writable = Boolean(input.writable)
		const drainOverflow = writable && isStorageSqlReturningMutation(query)
		return collectStorageSqlCursor(cursor, {
			drainOverflow,
			writeFinished: writable && isStorageSqlWrite(query),
			maxRows: maxStorageSqlQueryRows,
		})
	}
}

export const StorageRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	StorageRunnerBase,
)
export type StorageRunner = InstanceType<typeof StorageRunner>

export type StorageRunnerTransferStub = {
	exportStorage: (payload: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<StorageExportResult>
	importStorageValues: (payload: {
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; value: unknown }>
	}) => Promise<{ ok: true; written: number; cleared: boolean }>
	clearStorage: () => Promise<StorageClearResult>
	exportSqlSchema: () => Promise<Array<StorageSqlSchemaObject>>
	exportSqlRows: (payload: {
		table: string
		cursor: number | null
		pageSize?: number
	}) => Promise<StorageSqlRowsPage>
	importSqlSchema: (payload: {
		objects: Array<StorageSqlSchemaObject>
		phase: 'tables' | 'finish'
	}) => Promise<{ ok: true }>
	importSqlRows: (payload: {
		table: string
		columns: Array<string>
		rows: Array<Array<DumpSqlValue>>
	}) => Promise<{ written: number }>
	countSqlRows: () => Promise<Record<string, number>>
}

/**
 * Unmetered StorageRunner stub for operator copies between owners. It skips
 * bucket registration on purpose: an org resource transfer re-points the
 * `user_storage_buckets` row in its own D1 batch, and a registration upsert
 * for the target owner would collide with that row.
 */
export function storageRunnerTransferStub(input: {
	env: Pick<Env, 'STORAGE_RUNNER'>
	userId: OwnerId
	storageId: string
}): StorageRunnerTransferStub {
	return input.env.STORAGE_RUNNER.get(
		input.env.STORAGE_RUNNER.idFromName(
			storageRunnerDurableObjectName(input.userId, input.storageId),
		),
	) as unknown as StorageRunnerTransferStub
}

export function storageRunnerRpc(input: {
	env: Env
	userId: OwnerId
	storageId: string
}) {
	const runner = createMeteredDurableObjectStub({
		env: input.env,
		userId: input.userId,
		doClass: 'StorageRunner',
		stub: input.env.STORAGE_RUNNER.get(
			input.env.STORAGE_RUNNER.idFromName(
				storageRunnerDurableObjectName(input.userId, input.storageId),
			),
		) as unknown as {
			getValue: (payload: { key: string }) => Promise<{
				key: string
				value: unknown
			}>
			setValue: (payload: {
				key: string
				value: unknown
			}) => Promise<StorageSetResult>
			deleteValue: (payload: { key: string }) => Promise<StorageDeleteResult>
			clearStorage: () => Promise<StorageClearResult>
			getEstimatedBytes: () => Promise<StorageEstimateResult>
			listValues: (payload: {
				prefix?: string | null
				pageSize?: number
				startAfter?: string | null
			}) => Promise<StorageListResult>
			exportStorage: (payload: {
				pageSize?: number
				startAfter?: string | null
			}) => Promise<StorageExportResult>
			importStorage: (payload: {
				mode: 'replace'
				replacePage: 'first' | 'continue'
				entries: Array<{ key: string; valueJson: string }>
			}) => Promise<{ ok: true; written: number; cleared: boolean }>
			sqlQuery: (payload: {
				query: string
				params?: Array<unknown>
				writable?: boolean
			}) => Promise<StorageSqlReadCollection>
		},
	})

	// Registration must never run on a path that executes after the owning
	// user's D1 rows are removed. Account deletion clears StorageRunner DOs
	// via clearStorage, then deletes user_storage_buckets; registering on
	// clear would fire-and-forget an upsert that can recreate rows for a
	// deleted user. Clearing also is not evidence of use — prior writes
	// already registered the bucket.
	const registerOwnedBucket = () => {
		registerStorageBucket({
			env: input.env,
			userId: input.userId,
			storageId: input.storageId,
			kind: storageBucketKindFromStorageId(input.storageId),
		})
	}

	// After a successful mutation, opportunistically refresh this bucket's
	// stored estimate on its inventory row (throttled per isolate) so the
	// storage-byte entitlement baseline can read it from D1 instead of
	// probing every bucket's Durable Object. The persist is UPDATE-only, so
	// unlike registration it is safe on clearStorage paths that run while a
	// user or bucket is being deleted: it can never recreate a removed row.
	const refreshOwnedBucketEstimate = () => {
		maybeRefreshStorageBucketEstimate({
			env: input.env,
			userId: input.userId,
			storageId: input.storageId,
			readEstimatedBytes: async () =>
				(
					await withStorageEstimateReadTimeout(
						() => runner.getEstimatedBytes(),
						input.storageId,
					)
				).estimatedBytes,
		})
	}

	const attributedPackageId = packageIdFromStorageId(input.storageId)
	// Key-value reads on a SQLite-backed Durable Object are billed as rows
	// read: one per key (including cache hits) and one per listed entry. The
	// KV API exposes no cursor, so these are the billing units, not a guess.
	const recordRowsRead = (
		rowsRead: number,
		outcome: 'success' | 'error' = 'success',
	) => {
		recordDurableObjectRowsRead({
			env: input.env,
			userId: input.userId,
			doClass: 'StorageRunner',
			rowsRead,
			outcome,
			...(attributedPackageId ? { packageId: attributedPackageId } : {}),
		})
	}
	const finishSqlQuery = (collection: StorageSqlReadCollection) => {
		const settled = settleStorageSqlRead(collection)
		switch (settled.outcome) {
			case 'error':
				recordRowsRead(collection.rowsRead, 'error')
				console.warn('storage-sql-oversized-read', {
					userId: input.userId,
					storageId: input.storageId,
					rowsRead: collection.rowsRead,
					stopped: true,
				})
				throw settled.error
			case 'success':
				recordRowsRead(collection.rowsRead)
				if (settled.result.warning) {
					console.warn('storage-sql-oversized-read', {
						userId: input.userId,
						storageId: input.storageId,
						rowsRead: collection.rowsRead,
						stopped: false,
					})
				}
				return settled.result
			default: {
				const exhaustive: never = settled
				throw new Error(
					`Unknown storage sql read settlement: ${String(exhaustive)}`,
				)
			}
		}
	}

	return {
		getValue: async (payload: { key: string }) => {
			const result = await runner.getValue(payload)
			recordRowsRead(1)
			return result
		},
		setValue: async (payload: { key: string; value: unknown }) => {
			assertCloneableStorageValue(payload.value)
			registerOwnedBucket()
			const result = await runner.setValue(payload)
			refreshOwnedBucketEstimate()
			return result
		},
		deleteValue: async (payload: { key: string }) => {
			registerOwnedBucket()
			const result = await runner.deleteValue(payload)
			refreshOwnedBucketEstimate()
			return result
		},
		// clearStorage intentionally does not refresh the stored estimate:
		// nearly every clear precedes deletion of the inventory row (account,
		// package, and job cleanup), and the rare user-facing clear leaves at
		// most a stale-high estimate that over-counts (fail-safe) until the
		// bucket's next mutating write measures it live again.
		clearStorage: () => runner.clearStorage(),
		getEstimatedBytes: () => runner.getEstimatedBytes(),
		listValues: async (payload: {
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => {
			const result = await runner.listValues(payload)
			// The DO lists one extra entry to detect truncation.
			recordRowsRead(result.entries.length + (result.truncated ? 1 : 0))
			return result
		},
		exportStorage: (payload: {
			pageSize?: number
			startAfter?: string | null
		}) => runner.exportStorage(payload),
		importStorage: async (payload: {
			mode: 'replace'
			replacePage: 'first' | 'continue'
			entries: Array<{ key: string; valueJson: string }>
		}) => {
			registerOwnedBucket()
			const result = await runner.importStorage(payload)
			refreshOwnedBucketEstimate()
			return result
		},
		sqlQuery: async (payload: {
			query: string
			params?: Array<unknown>
			writable?: boolean
		}) => {
			const mutating =
				Boolean(payload.writable) && !isReadOnlyStorageSqlQuery(payload.query)
			if (payload.writable) {
				registerOwnedBucket()
			}
			const result = await runner.sqlQuery(payload)
			if (mutating) {
				refreshOwnedBucketEstimate()
			}
			return finishSqlQuery(result)
		},
	}
}

async function readStorageEstimateChunkWithRetry(input: {
	env: Env
	userId: OwnerId
	buckets: Array<{ storageId: string; kind: StorageBucketKind }>
	/** Backoff pauses between attempts; attempts = length + 1. */
	retryDelaysMs?: ReadonlyArray<number>
}): Promise<Array<StorageEstimateResult>> {
	const retryDelaysMs = input.retryDelaysMs ?? storageEstimateReadRetryDelaysMs
	const maxAttempts = retryDelaysMs.length + 1
	const inflightReads = new Map<string, Promise<StorageEstimateResult>>()
	const startOrReuseRead = (bucket: {
		storageId: string
		kind: StorageBucketKind
	}) => {
		const existing = inflightReads.get(bucket.storageId)
		if (existing) return existing
		const rpc = (() => {
			switch (bucket.kind) {
				case 'repo_session':
					return repoSessionRpc(
						input.env,
						repoSessionIdFromStorageBucketId(bucket.storageId),
					).getEstimatedBytes()
				case 'job':
				case 'package':
				case 'execute':
				case 'unknown':
					return storageRunnerRpc({
						env: input.env,
						userId: input.userId,
						storageId: bucket.storageId,
					}).getEstimatedBytes()
				default: {
					const exhaustive: never = bucket.kind
					throw new Error(
						`Unsupported storage bucket kind: ${String(exhaustive)}`,
					)
				}
			}
		})()
		// Keep a fulfilled read in the map until this baseline returns so a
		// timeout-then-success during backoff is reused instead of opening a
		// second stub call. Only rejected RPCs are dropped so the next
		// attempt can start a new one.
		inflightReads.set(bucket.storageId, rpc)
		void rpc.catch(() => {
			if (inflightReads.get(bucket.storageId) === rpc) {
				inflightReads.delete(bucket.storageId)
			}
		})
		return rpc
	}
	const readOne = (bucket: { storageId: string; kind: StorageBucketKind }) =>
		withStorageEstimateReadTimeout(
			() => startOrReuseRead(bucket),
			bucket.storageId,
		)

	const values: Array<StorageEstimateResult | undefined> = Array.from({
		length: input.buckets.length,
	})
	let pendingIndexes = input.buckets.map((_bucket, index) => index)
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		// Wait for every attempt's reads to settle before retrying so a fast
		// rejection cannot overlap still-pending peers and exceed the fan-out
		// cap.
		const results = await Promise.allSettled(
			pendingIndexes.map((index) =>
				readOne(
					input.buckets[index] ?? {
						storageId: 'unknown',
						kind: 'unknown',
					},
				),
			),
		)
		const failedIndexes: Array<number> = []
		let firstFailureReason: unknown
		for (const [resultIndex, result] of results.entries()) {
			const index = pendingIndexes[resultIndex]
			if (index === undefined) continue
			if (result.status === 'fulfilled') {
				values[index] = result.value
				continue
			}
			if (failedIndexes.length === 0) {
				firstFailureReason = result.reason
			}
			failedIndexes.push(index)
		}
		if (failedIndexes.length === 0) break
		if (attempt === maxAttempts) {
			// An unreadable bucket cannot safely be treated as zero usage.
			throw createStorageEstimateReadError({
				storageId:
					input.buckets[failedIndexes[0] ?? -1]?.storageId ?? 'unknown',
				attempts: maxAttempts,
				cause: firstFailureReason,
			})
		}
		pendingIndexes = failedIndexes
		const pendingReads = failedIndexes
			.map((index) => {
				const storageId = input.buckets[index]?.storageId
				return storageId ? inflightReads.get(storageId) : undefined
			})
			.filter((value): value is Promise<StorageEstimateResult> => value != null)
		await Promise.race([
			new Promise<void>((resolve) => {
				setTimeout(resolve, retryDelaysMs[attempt - 1] ?? 0)
			}),
			pendingReads.length > 0
				? Promise.allSettled(pendingReads).then(() => undefined)
				: new Promise<void>(() => {}),
		])
	}
	return values.map((value, index) => {
		if (value === undefined) {
			throw createStorageEstimateReadError({
				storageId: input.buckets[index]?.storageId ?? 'unknown',
				attempts: maxAttempts,
				cause: new Error('Storage estimate retry completed without a value.'),
			})
		}
		return value
	})
}

/**
 * One bucket's live `getEstimatedBytes`, bounded by the estimate read
 * timeout and retried per `retryDelaysMs` (defaults to the entitlement
 * policy). Throws the fail-closed estimate read error when every attempt
 * fails. Used by the estimate backfill lane.
 */
export async function readStorageBucketEstimatedBytes(input: {
	env: Env
	userId: OwnerId
	storageId: string
	retryDelaysMs?: ReadonlyArray<number>
}): Promise<number> {
	const estimates = await readStorageEstimateChunkWithRetry({
		env: input.env,
		userId: input.userId,
		buckets: [
			{
				storageId: input.storageId,
				kind: storageBucketKindFromStorageId(input.storageId),
			},
		],
		retryDelaysMs: input.retryDelaysMs,
	})
	return estimates[0]?.estimatedBytes ?? 0
}

export async function readInventoriedStorageBucketEstimatedBytes(input: {
	env: Env
	userId: OwnerId
	storageId: string
	kind: StorageBucketKind
	retryDelaysMs?: ReadonlyArray<number>
}): Promise<number> {
	const estimates = await readStorageEstimateChunkWithRetry({
		env: input.env,
		userId: input.userId,
		buckets: [{ storageId: input.storageId, kind: input.kind }],
		retryDelaysMs: input.retryDelaysMs,
	})
	return estimates[0]?.estimatedBytes ?? 0
}

async function readStorageBytesEntitlementBaseline(input: {
	env: Env
	userId: OwnerId
	storageId: string
}) {
	const [d1Bytes, bucketEstimates] = await Promise.all([
		readStorageBytesFromUserMeter({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			now: new Date(),
		}),
		listUserStorageBucketEstimates({
			env: input.env,
			userId: input.userId,
		}),
	])
	// Registration is asynchronous, so include the bucket being written even
	// when its inventory row has not landed yet. The Map avoids double-counting
	// once it is registered.
	const estimatesByStorageId = new Map<
		string,
		{ kind: StorageBucketKind; estimatedBytes: number | null }
	>(
		bucketEstimates.map((bucket) => [
			bucket.storageId,
			{ kind: bucket.kind, estimatedBytes: bucket.estimatedBytes },
		]),
	)
	if (!estimatesByStorageId.has(input.storageId)) {
		estimatesByStorageId.set(input.storageId, {
			kind: storageBucketKindFromStorageId(input.storageId),
			estimatedBytes: null,
		})
	}
	// Live getEstimatedBytes RPCs are limited to the bucket that triggered
	// this baseline read (fresh measurement for the bucket about to grow)
	// plus any bucket whose inventory row has no stored estimate yet; probed
	// values are persisted below and the estimate backfill lane retries any
	// row that stays unmeasured. Every other bucket contributes its stored
	// D1 estimate, so the cold mutating path no longer fans out across the
	// whole inventory. With a run cache, a later write in the same run that
	// targets a different already-inventoried bucket reuses that bucket's
	// stored estimate rather than probing it live — bounded staleness the
	// run cache offsets by accumulating the run's own reserved bytes.
	let durableObjectBytes = 0
	const bucketsToProbe: Array<{
		storageId: string
		kind: StorageBucketKind
	}> = []
	for (const [storageId, bucket] of estimatesByStorageId) {
		if (storageId === input.storageId || bucket.estimatedBytes === null) {
			bucketsToProbe.push({ storageId, kind: bucket.kind })
			continue
		}
		durableObjectBytes += bucket.estimatedBytes
	}
	for (
		let offset = 0;
		offset < bucketsToProbe.length;
		offset += maxConcurrentStorageEstimateReads
	) {
		const chunk = bucketsToProbe.slice(
			offset,
			offset + maxConcurrentStorageEstimateReads,
		)
		const estimates = await readStorageEstimateChunkWithRetry({
			env: input.env,
			userId: input.userId,
			buckets: chunk,
		})
		for (const [index, estimate] of estimates.entries()) {
			durableObjectBytes += estimate.estimatedBytes
			// Fire-and-forget persist (UPDATE-only) so the next isolate reads
			// this bucket's estimate from D1 instead of probing the DO again.
			recordStorageBucketEstimate({
				env: input.env,
				userId: input.userId,
				storageId: chunk[index]?.storageId,
				estimatedBytes: estimate.estimatedBytes,
			})
		}
	}
	return {
		bytes: d1Bytes + durableObjectBytes,
		storageIds: new Set(estimatesByStorageId.keys()),
	}
}

async function assertStorageBytesWithKindSummary(input: {
	env: Env
	userId: OwnerId
	email: string | null | undefined
	requested?: number
	getCurrent: () => Promise<number>
}) {
	try {
		await assertWithinStorageBytesEntitlement({
			db: input.env.APP_DB,
			userId: input.userId,
			email: input.email,
			requested: input.requested,
			getCurrent: input.getCurrent,
		})
	} catch (error) {
		if (!(error instanceof EntitlementLimitError)) throw error
		if (error.details.resource !== 'storage_bytes') throw error
		const buckets = await listUserStorageBucketEstimates({
			env: input.env,
			userId: input.userId,
		}).catch(() => [])
		const summary = formatStorageBucketKindSummary(buckets)
		if (!summary) throw error
		const { code: _code, ...details } = error.details
		throw new EntitlementLimitError({
			...details,
			upgradeHint: `${details.upgradeHint} ${summary}`,
		})
	}
}

export async function assertStorageRunnerWriteWithinEntitlement(input: {
	env: Env
	userId: OwnerId
	email: string | null | undefined
	storageId: string
	requested?: number
	/**
	 * Optional per-sandbox memo. When set, the baseline read (D1 sums plus
	 * the bounded live probes) runs once; later asserts reuse the baseline
	 * and accumulate reserved bytes from earlier accepted writes in this run.
	 */
	cache?: StorageBytesEntitlementRunCache | null
}) {
	const cache = input.cache
	if (cache) {
		const beginBaselineRead = (storageId: string) => {
			const pending = readStorageBytesEntitlementBaseline({
				env: input.env,
				userId: input.userId,
				storageId,
			}).catch((error: unknown) => {
				// Do not memoize a transient failure for the whole run — the
				// uncached path recovers on retry; the cache must too.
				if (cache.baseline === pending) {
					cache.baseline = null
				}
				throw error
			})
			cache.baseline = pending
			return pending
		}
		const loadBaseline = () => {
			if (!cache.baseline) {
				return beginBaselineRead(input.storageId)
			}
			return cache.baseline
		}
		let baseline = await loadBaseline()
		if (!baseline.storageIds.has(input.storageId)) {
			// A write targeted a bucket missing from the first scan (registration
			// race or first touch). Recompute so the new bucket is counted.
			baseline = await beginBaselineRead(input.storageId)
		}
		await assertStorageBytesWithKindSummary({
			env: input.env,
			userId: input.userId,
			email: input.email,
			requested: input.requested,
			getCurrent: async () => baseline.bytes + cache.reservedBytes,
		})
		cache.reservedBytes += input.requested ?? 0
		return
	}

	await assertStorageBytesWithKindSummary({
		env: input.env,
		userId: input.userId,
		email: input.email,
		requested: input.requested,
		getCurrent: async () =>
			(
				await readStorageBytesEntitlementBaseline({
					env: input.env,
					userId: input.userId,
					storageId: input.storageId,
				})
			).bytes,
	})
}

export function createStorageKodyTools(input: {
	env: Env
	userId: OwnerId
	email?: string | null
	storageId: string
	writable: boolean
	/**
	 * Optional per-sandbox memo shared across storage tool instances so many
	 * mutating SQL/set calls do not rescan every inventoried bucket.
	 */
	entitlementCache?: StorageBytesEntitlementRunCache | null
}) {
	const runner = storageRunnerRpc({
		env: input.env,
		userId: input.userId,
		storageId: input.storageId,
	})
	const assertWriteWithinEntitlement = async (requested?: number) => {
		await assertStorageRunnerWriteWithinEntitlement({
			env: input.env,
			userId: input.userId,
			email: input.email,
			storageId: input.storageId,
			requested,
			cache: input.entitlementCache,
		})
	}
	return {
		storageGet: async (args: unknown) => {
			const key =
				typeof args === 'object' && args !== null && 'key' in args
					? String((args as { key: unknown }).key ?? '')
					: ''
			return await runner.getValue({ key })
		},
		storageList: async (args: unknown) => {
			const payload =
				typeof args === 'object' && args !== null
					? (args as {
							prefix?: string | null
							pageSize?: number
							startAfter?: string | null
						})
					: {}
			return await runner.listValues({
				prefix: typeof payload.prefix === 'string' ? payload.prefix : undefined,
				pageSize:
					typeof payload.pageSize === 'number' ? payload.pageSize : undefined,
				startAfter:
					typeof payload.startAfter === 'string'
						? payload.startAfter
						: undefined,
			})
		},
		storageSql: async (args: unknown) => {
			const payload =
				typeof args === 'object' && args !== null
					? (args as {
							query?: unknown
							params?: unknown
							writable?: unknown
						})
					: {}
			const writable = input.writable
				? payload.writable === undefined
					? true
					: Boolean(payload.writable)
				: false
			const query = assertStorageSqlAllowed(
				typeof payload.query === 'string' ? payload.query : '',
				writable,
			)
			const params = Array.isArray(payload.params) ? payload.params : undefined
			// packageStorage()/writable helpers always pass writable:true so
			// CREATE/INSERT are allowed, but pure reads must not pay the
			// all-bucket entitlement fan-out.
			if (writable && !isReadOnlyStorageSqlQuery(query)) {
				await assertWriteWithinEntitlement(
					estimateEntitlementStorageSqlWriteBytes({
						query,
						params,
					}),
				)
			}
			return await runner.sqlQuery({
				query,
				params,
				writable,
			})
		},
		...(input.writable
			? {
					storageSet: async (args: unknown) => {
						const payload =
							typeof args === 'object' && args !== null
								? (args as { key?: unknown; value?: unknown })
								: {}
						const key = typeof payload.key === 'string' ? payload.key : ''
						const existing = await runner.getValue({ key })
						await assertWriteWithinEntitlement(
							estimateEntitlementStorageEntryByteDelta({
								next: {
									key,
									value: payload.value,
								},
								existing:
									existing.value === null
										? null
										: {
												key,
												value: existing.value,
											},
							}),
						)
						return await runner.setValue({
							key,
							value: payload.value,
						})
					},
					storageDelete: async (args: unknown) => {
						const key =
							typeof args === 'object' && args !== null && 'key' in args
								? String((args as { key: unknown }).key ?? '')
								: ''
						return await runner.deleteValue({ key })
					},
					storageClear: async () => {
						return await runner.clearStorage()
					},
				}
			: {}),
	}
}

export function createPackageStorageAccessDeniedMessage(packageId: string) {
	return (
		`packageStorage() cannot access the storage of package "${packageId}" from this execution context. ` +
		'Package storage access is granted only from bundler-recorded provenance: the running package itself and ' +
		'the saved packages this bundle statically imported (kody:@scope/package/export). If the target package is ' +
		'known when the code is written, statically import one of its exports so the bundler records the dependency; ' +
		"otherwise import(specifier) a caller-owned or forked package when the name is data so that package's " +
		'own runtime does the reading and writing.'
	)
}

/**
 * `kody.package_storage_*` tools backing the `packageStorage()` runtime
 * helper. Unlike `createStorageKodyTools` (bound to one storage id for a
 * whole run) these take a `packageId` argument per call, because one bundle
 * can contain modules from several saved packages that each own a bucket.
 *
 * Security boundary: the sandbox-supplied `packageId` is honored only when
 * it is in `grantedPackageIds`, which the host computes from
 * bundler-controlled provenance metadata (the run's own package context and
 * the bundle's recorded static/dynamic package dependencies). Hand-written
 * module source claiming an arbitrary package id is rejected here even if it
 * forges a stamped-looking call, so a malicious package cannot reach other
 * installed packages' buckets. Cross-user access is structurally impossible:
 * `storageRunnerDurableObjectName` keys the durable object on this run's user id.
 */
export const packageStorageRetrieverReadOnlyMessage =
	'packageStorage() is read-only during retriever runs. Persist writes from an export, job, or execute call.'

export function createPackageStorageKodyTools(input: {
	env: Env
	userId: OwnerId
	email?: string | null
	grantedPackageIds: ReadonlySet<string>
	writable?: boolean
}) {
	const writable = input.writable !== false
	// One cache for the whole sandbox so nested packageStorage() SQL across
	// granted packages (and repeated CREATE/INSERT in one export) does not
	// rescan every inventoried bucket on each statement.
	const entitlementCache = createStorageBytesEntitlementRunCache()
	const createGrantedStorageTools = (packageId: string) => {
		const {
			storageGet,
			storageList,
			storageSql,
			storageSet,
			storageDelete,
			storageClear,
		} = createStorageKodyTools({
			env: input.env,
			userId: input.userId,
			email: input.email,
			storageId: buildPackageStorageId(packageId),
			writable,
			entitlementCache,
		})
		if (writable && (!storageSet || !storageDelete || !storageClear)) {
			// createStorageKodyTools only omits these when writable is false.
			throw new Error('Writable package storage tools are missing writes.')
		}
		return {
			storageGet,
			storageList,
			storageSql,
			storageSet,
			storageDelete,
			storageClear,
		}
	}
	const toolsByPackageId = new Map<
		string,
		ReturnType<typeof createGrantedStorageTools>
	>()
	const resolveTools = (args: unknown) => {
		const packageId =
			typeof args === 'object' && args !== null && 'packageId' in args
				? String((args as { packageId: unknown }).packageId ?? '').trim()
				: ''
		if (!packageId) {
			throw new Error('packageStorage requires a non-empty package id.')
		}
		if (!input.grantedPackageIds.has(packageId)) {
			throw new Error(createPackageStorageAccessDeniedMessage(packageId))
		}
		let tools = toolsByPackageId.get(packageId)
		if (!tools) {
			tools = createGrantedStorageTools(packageId)
			toolsByPackageId.set(packageId, tools)
		}
		return tools
	}
	const rejectReadOnlyWrite = async () => {
		throw new Error(packageStorageRetrieverReadOnlyMessage)
	}
	return {
		packageStorageGet: async (args: unknown) =>
			await resolveTools(args).storageGet(args),
		packageStorageList: async (args: unknown) =>
			await resolveTools(args).storageList(args),
		packageStorageSql: async (args: unknown) =>
			await resolveTools(args).storageSql(args),
		packageStorageSet: writable
			? async (args: unknown) => await resolveTools(args).storageSet!(args)
			: rejectReadOnlyWrite,
		packageStorageDelete: writable
			? async (args: unknown) => await resolveTools(args).storageDelete!(args)
			: rejectReadOnlyWrite,
		packageStorageClear: writable
			? async (args: unknown) => await resolveTools(args).storageClear!()
			: rejectReadOnlyWrite,
	}
}

/**
 * Sandbox-side factory behind the `packageStorage()` runtime export. The
 * virtual `kody:runtime` module resolves the declaring package id (from the
 * bundle-time stamp or the run's own package context) and calls this factory
 * through the AsyncLocalStorage runtime store; the host still validates the
 * id against the run's provenance grants in `createPackageStorageKodyTools`.
 */
export function createPackageStorageHelperPrelude(input?: {
	writable?: boolean
}) {
	const writable = input?.writable !== false
	// `id` mirrors buildPackageStorageId above (covered by a unit test).
	// Retriever runs pass writable:false so set/delete/clear/sql mutations
	// fail in the sandbox instead of depending on a convention.
	return `
const __kodyPackageStorage = (packageId) => ({
  id: 'package:' + encodeURIComponent(packageId),
  get: async (key) => (await ${kodyCallDispatcherName}('packageStorageGet', { packageId, key })).value,
  list: async (options = {}) => await ${kodyCallDispatcherName}('packageStorageList', { ...options, packageId }),
  sql: async (query, params = []) =>
    await ${kodyCallDispatcherName}('packageStorageSql', {
      packageId,
      query,
      params,
      writable: ${writable ? 'true' : 'false'},
    }),
  set: async (key, value) => await ${kodyCallDispatcherName}('packageStorageSet', { packageId, key, value }),
  delete: async (key) => await ${kodyCallDispatcherName}('packageStorageDelete', { packageId, key }),
  clear: async () => await ${kodyCallDispatcherName}('packageStorageClear', { packageId }),
});
	`.trim()
}

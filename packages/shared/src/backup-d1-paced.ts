/**
 * Contracts for the non-disruptive paced D1 backup lane.
 *
 * Layout (reuses existing `daily/` / `weekly/` / `staging/` lifecycle prefixes):
 *
 * - `staging/{day}/d1-paced/{databaseName}/...` — mutable night work
 * - `daily/d1-paced/{databaseId}/{day}/...` — sealed weekday (and shadow) nights
 * - `weekly/d1-paced/{databaseId}/{day}/...` — sealed Sunday UTC full bases
 *
 * The Cloudflare REST export under `daily/d1/...` / `weekly/d1/...` stays
 * unchanged. Shadow mode writes paced artifacts alongside it.
 */

import { isRecord } from './is-record.ts'

export const pacedD1BackupSchemaVersion = 1 as const

/** Ephemeral / platform-internal tables never included in paced backups. */
export const pacedD1BackupSkipTables: ReadonlySet<string> = new Set([
	'_rate_limits',
	'_cf_KV',
	'_cf_METADATA',
	'sqlite_sequence',
])

export const pacedD1BackupDefaultTargetPageMs = 25
export const pacedD1BackupDefaultDutyCycle = 0.25
export const pacedD1BackupDefaultMinPage = 50
export const pacedD1BackupDefaultMaxPage = 2000
export const pacedD1BackupDefaultMaxPageBytes = 1_500_000
export const pacedD1BackupDefaultMinGapMs = 20
/** D1 import rejects statements above ~100 KiB. */
export const pacedD1BackupMaxSqlStatementBytes = 100_000
/** Chunk size when splitting oversized text columns during restore SQL. */
export const pacedD1BackupRestoreTextChunkChars = 30_000

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const databaseNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export type PacedD1RetentionTier = 'daily' | 'weekly'

export type PacedD1TableMode = 'full' | 'delta'

export type PacedD1SqliteSequenceRow = {
	name: string
	seq: number
}

export type PacedD1SchemaExtra = {
	type: 'index' | 'trigger'
	name: string
	table: string
	sql: string
}

export type PacedD1TableManifest = {
	mode: PacedD1TableMode
	schemaHash: string
	sql: string
	cols: Array<string>
	pk: Array<string>
	declaredPk: Array<string>
	count: number
	checksum: string
	upserts: number
	deletes: number
	dataSha256: string
	indexSha256: string
}

export type PacedD1NightStats = {
	wallMs: number
	queries: number
	rowsRead: number
	d1RowsRead: number
	bytesOut: number
	queryMs: {
		p50: number
		p95: number
		p99: number
		max: number
		sum: number
	}
	/** Fraction of wall time spent inside D1 queries (queryMs.sum / wallMs). */
	dbTimeShare: number
}

export type PacedD1NightManifest = {
	schemaVersion: typeof pacedD1BackupSchemaVersion
	databaseName: string
	databaseId: string
	day: string
	retentionTier: PacedD1RetentionTier
	startedAt: string
	finishedAt: string
	prevDay: string | null
	prevManifestSha256: string | null
	schemaHash: string
	schemaStableDuringWalk: boolean
	timeTravelBookmark: string | null
	extras: Array<PacedD1SchemaExtra>
	sqliteSequence: Array<PacedD1SqliteSequenceRow>
	tables: Record<string, PacedD1TableManifest>
	stats: PacedD1NightStats
	shadow: boolean
}

export type PacedD1ProgressCursor = {
	schemaVersion: typeof pacedD1BackupSchemaVersion
	day: string
	databaseName: string
	databaseId: string
	retentionTier: PacedD1RetentionTier
	startedAt: string
	prevDay: string | null
	prevManifestSha256: string | null
	schemaHash: string
	/** Tables already finished (data+index flushed). */
	completedTables: Array<string>
	/** Table currently being scanned, or null when between tables. */
	currentTable: string | null
	/** Last rowid emitted for `currentTable` (keyset cursor). */
	lastRowid: number | null
	pageSize: number
	partialUpserts: number
	partialDeletes: number
	partialCount: number
	partialChecksum: string
	revision: number
}

export function assertBackupDay(day: string): void {
	if (!dayPattern.test(day)) {
		throw new Error(`invalid backup day: ${day}`)
	}
}

export function assertPacedDatabaseName(name: string): void {
	if (!databaseNamePattern.test(name)) {
		throw new Error(`invalid paced database name: ${name}`)
	}
}

export function pacedD1StagingPrefix(
	day: string,
	databaseName: string,
): string {
	assertBackupDay(day)
	assertPacedDatabaseName(databaseName)
	return `staging/${day}/d1-paced/${databaseName}/`
}

export function pacedD1StagingProgressKey(
	day: string,
	databaseName: string,
): string {
	return `${pacedD1StagingPrefix(day, databaseName)}progress.json`
}

export function pacedD1StagingManifestKey(
	day: string,
	databaseName: string,
): string {
	return `${pacedD1StagingPrefix(day, databaseName)}manifest.json`
}

export function pacedD1StagingDataKey(
	day: string,
	databaseName: string,
	table: string,
): string {
	return `${pacedD1StagingPrefix(day, databaseName)}data/${encodeURIComponent(table)}.tsv`
}

export function pacedD1StagingIndexKey(
	day: string,
	databaseName: string,
	table: string,
): string {
	return `${pacedD1StagingPrefix(day, databaseName)}index/${encodeURIComponent(table)}.tsv`
}

export function pacedD1StagingTimeTravelKey(
	day: string,
	databaseName: string,
): string {
	return `${pacedD1StagingPrefix(day, databaseName)}time-travel.json`
}

export function pacedD1SealedPrefix(
	tier: PacedD1RetentionTier,
	databaseId: string,
	day: string,
): string {
	assertBackupDay(day)
	if (!/^[0-9a-f-]{36}$/i.test(databaseId)) {
		throw new Error(`invalid paced database id: ${databaseId}`)
	}
	return `${tier}/d1-paced/${databaseId.toLowerCase()}/${day}/`
}

export function pacedD1SealedManifestKey(
	tier: PacedD1RetentionTier,
	databaseId: string,
	day: string,
): string {
	return `${pacedD1SealedPrefix(tier, databaseId, day)}manifest.json`
}

export function pacedD1SealedDataKey(
	tier: PacedD1RetentionTier,
	databaseId: string,
	day: string,
	table: string,
): string {
	return `${pacedD1SealedPrefix(tier, databaseId, day)}data/${encodeURIComponent(table)}.tsv`
}

export function pacedD1SealedIndexKey(
	tier: PacedD1RetentionTier,
	databaseId: string,
	day: string,
	table: string,
): string {
	return `${pacedD1SealedPrefix(tier, databaseId, day)}index/${encodeURIComponent(table)}.tsv`
}

/**
 * Sunday UTC nights force a full base copy even when the schema is unchanged.
 * Weekday nights may emit per-table deltas against the previous sealed index.
 */
export function pacedD1RetentionTierForDay(day: string): PacedD1RetentionTier {
	assertBackupDay(day)
	const [year, month, date] = day.split('-').map(Number) as [
		number,
		number,
		number,
	]
	// Date.UTC Sunday === 0
	return new Date(Date.UTC(year, month - 1, date)).getUTCDay() === 0
		? 'weekly'
		: 'daily'
}

export function pacedD1ForcesFullBase(day: string): boolean {
	return pacedD1RetentionTierForDay(day) === 'weekly'
}

export function adaptPacedPageSize(input: {
	page: number
	durationMs: number
	pageBytes: number
	targetMs?: number
	minPage?: number
	maxPage?: number
	maxBytes?: number
}): number {
	const targetMs = input.targetMs ?? pacedD1BackupDefaultTargetPageMs
	const minPage = input.minPage ?? pacedD1BackupDefaultMinPage
	const maxPage = input.maxPage ?? pacedD1BackupDefaultMaxPage
	const maxBytes = input.maxBytes ?? pacedD1BackupDefaultMaxPageBytes
	let page = input.page
	if (input.durationMs > targetMs * 1.5 || input.pageBytes > maxBytes) {
		page = Math.max(minPage, Math.floor(page / 2))
	} else if (
		input.durationMs < targetMs / 2 &&
		input.pageBytes * 2 < maxBytes
	) {
		page = Math.min(maxPage, page * 2)
	}
	return page
}

/**
 * Sleep so D1 query time stays near `dutyCycle` of wall time on the backup lane.
 * When latency rises, the gap grows automatically with `durationMs`.
 */
export function pacedBackupGapMs(input: {
	durationMs: number
	dutyCycle?: number
	minGapMs?: number
}): number {
	const dutyCycle = input.dutyCycle ?? pacedD1BackupDefaultDutyCycle
	const minGapMs = input.minGapMs ?? pacedD1BackupDefaultMinGapMs
	if (!(dutyCycle > 0) || dutyCycle >= 1) {
		return minGapMs
	}
	return Math.max(minGapMs, (input.durationMs * (1 - dutyCycle)) / dutyCycle)
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isTableManifest(value: unknown): value is PacedD1TableManifest {
	return (
		isRecord(value) &&
		(value.mode === 'full' || value.mode === 'delta') &&
		typeof value.schemaHash === 'string' &&
		sha256Pattern.test(value.schemaHash) &&
		typeof value.sql === 'string' &&
		Array.isArray(value.cols) &&
		value.cols.every((col) => typeof col === 'string') &&
		Array.isArray(value.pk) &&
		value.pk.every((col) => typeof col === 'string') &&
		Array.isArray(value.declaredPk) &&
		value.declaredPk.every((col) => typeof col === 'string') &&
		Number.isSafeInteger(value.count) &&
		Number(value.count) >= 0 &&
		typeof value.checksum === 'string' &&
		/^[0-9a-f]{16}$/.test(value.checksum) &&
		Number.isSafeInteger(value.upserts) &&
		Number.isSafeInteger(value.deletes) &&
		typeof value.dataSha256 === 'string' &&
		sha256Pattern.test(value.dataSha256) &&
		typeof value.indexSha256 === 'string' &&
		sha256Pattern.test(value.indexSha256)
	)
}

export function parsePacedD1NightManifest(
	value: unknown,
): PacedD1NightManifest {
	if (
		!isRecord(value) ||
		value.schemaVersion !== pacedD1BackupSchemaVersion ||
		!isNonemptyString(value.databaseName) ||
		!isNonemptyString(value.databaseId) ||
		typeof value.day !== 'string' ||
		!dayPattern.test(value.day) ||
		(value.retentionTier !== 'daily' && value.retentionTier !== 'weekly') ||
		!isNonemptyString(value.startedAt) ||
		!isNonemptyString(value.finishedAt) ||
		!(value.prevDay === null || dayPattern.test(String(value.prevDay))) ||
		!(
			value.prevManifestSha256 === null ||
			(typeof value.prevManifestSha256 === 'string' &&
				sha256Pattern.test(value.prevManifestSha256))
		) ||
		typeof value.schemaHash !== 'string' ||
		!sha256Pattern.test(value.schemaHash) ||
		typeof value.schemaStableDuringWalk !== 'boolean' ||
		!(
			value.timeTravelBookmark === null ||
			isNonemptyString(value.timeTravelBookmark)
		) ||
		!Array.isArray(value.extras) ||
		!Array.isArray(value.sqliteSequence) ||
		!isRecord(value.tables) ||
		!Object.values(value.tables).every(isTableManifest) ||
		!isRecord(value.stats) ||
		typeof value.shadow !== 'boolean'
	) {
		throw new Error('paced D1 night manifest has an invalid versioned shape')
	}
	return value as PacedD1NightManifest
}

export function parsePacedD1ProgressCursor(
	value: unknown,
): PacedD1ProgressCursor {
	if (
		!isRecord(value) ||
		value.schemaVersion !== pacedD1BackupSchemaVersion ||
		typeof value.day !== 'string' ||
		!dayPattern.test(value.day) ||
		!isNonemptyString(value.databaseName) ||
		!isNonemptyString(value.databaseId) ||
		(value.retentionTier !== 'daily' && value.retentionTier !== 'weekly') ||
		!isNonemptyString(value.startedAt) ||
		!(value.prevDay === null || dayPattern.test(String(value.prevDay))) ||
		!(
			value.prevManifestSha256 === null ||
			(typeof value.prevManifestSha256 === 'string' &&
				sha256Pattern.test(value.prevManifestSha256))
		) ||
		typeof value.schemaHash !== 'string' ||
		!sha256Pattern.test(value.schemaHash) ||
		!Array.isArray(value.completedTables) ||
		!value.completedTables.every((name) => typeof name === 'string') ||
		!(value.currentTable === null || typeof value.currentTable === 'string') ||
		!(
			value.lastRowid === null ||
			(typeof value.lastRowid === 'number' &&
				Number.isSafeInteger(value.lastRowid))
		) ||
		!Number.isSafeInteger(value.pageSize) ||
		!Number.isSafeInteger(value.partialUpserts) ||
		!Number.isSafeInteger(value.partialDeletes) ||
		!Number.isSafeInteger(value.partialCount) ||
		typeof value.partialChecksum !== 'string' ||
		!Number.isSafeInteger(value.revision)
	) {
		throw new Error('paced D1 progress cursor has an invalid versioned shape')
	}
	return value as PacedD1ProgressCursor
}

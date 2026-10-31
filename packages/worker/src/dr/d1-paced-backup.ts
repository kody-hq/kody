import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	pacedD1StagingDataKey,
	pacedD1StagingDataPartKey,
	pacedD1StagingIndexKey,
	pacedD1StagingIndexPartKey,
	pacedD1StagingManifestKey,
	pacedD1StagingPrefix,
	pacedD1StagingProgressKey,
	parsePacedD1NightManifest,
	parsePacedD1ProgressCursor,
	type PacedD1NightManifest,
	type PacedD1ProgressCursor,
	type PacedD1TableManifest,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	parsePacedD1IndexLine,
	sha256HexOfBytes,
	sha256HexOfText,
	type PacedD1IndexEntry,
} from '@kody-internal/shared/backup-d1-paced-encode.ts'
import {
	buildPacedD1NightManifest,
	createMemoryPacedD1IndexReader,
	discoverPacedD1Schema,
	resolvePacedD1TableMode,
	summarizePacedQueryMs,
	walkPacedD1Table,
	type PacedD1Database,
	type PacedD1DiscoveredTable,
	type PacedD1SchemaSnapshot,
	type PacedD1TableArtifactWriter,
	type PacedD1WalkerOptions,
} from '@kody-internal/shared/backup-d1-paced-walker.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import {
	d1PacedBackupCatchUpLookbackDays,
	isD1PacedBackupConfigured,
	shouldRunD1PacedBackupCatchUpCron,
	shouldRunD1PacedBackupCron,
} from '#worker/dr/d1-paced-backup-schedule.ts'
import {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'
import {
	parsePacedD1PartsPointer,
	sealPacedD1SourceNight,
} from '#worker/dr/d1-paced-backup-seal.ts'

export {
	d1PacedBackupCatchUpLookbackDays,
	isD1PacedBackupConfigured,
	shouldRunD1PacedBackupCatchUpCron,
	shouldRunD1PacedBackupCron,
	shouldRunD1PacedBackupWatchdogCron,
	shouldRunD1PacedRestoreDrillCron,
	shouldRunD1PacedFreshnessCron,
} from '#worker/dr/d1-paced-backup-schedule.ts'
export {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceBinding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'
export {
	sealPacedD1SourceNight,
	type SealPacedD1SourceNightResult,
} from '#worker/dr/d1-paced-backup-seal.ts'

/** Wall budget for one paced D1 cron tick (same order as DR exporter). */
export const d1PacedBackupRunTimeBudgetMs = 45_000

/**
 * Flush a staging part when the in-tick TSV buffers reach this many UTF-8
 * bytes (data + index). Keeps peak heap well under the Workers isolate limit
 * even on full-base walks of APP/AUDIT.
 */
export const d1PacedBackupPartMaxBytes = 4 * 1024 * 1024

/**
 * Soft per-tick emitted-byte budget. Once flushed bytes for the tick hit this
 * cap, the walker stops between pages so the next tick resumes — even if wall
 * time remains.
 */
export const d1PacedBackupTickByteBudget = 8 * 1024 * 1024

const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string) {
	return utf8Encoder.encode(text).byteLength
}
type NightMeta = {
	schemaVersion: typeof pacedD1BackupSchemaVersion
	day: string
	databaseName: string
	databaseId: string
	startedAt: string
	prevDay: string | null
	prevManifestSha256: string | null
	schemaHash: string
	schemaStableDuringWalk: boolean
	timeTravelBookmark: string | null
	extras: PacedD1SchemaSnapshot['extras']
	sqliteSequence: PacedD1SchemaSnapshot['sqliteSequence']
	queries: number
	rowsRead: number
	d1RowsRead: number
	bytesOut: number
	queryMs: Array<number>
	wallStartedAtMs: number
}

type LaneProgress = {
	schemaVersion: typeof pacedD1BackupSchemaVersion
	day: string
	nextSourceIndex: number
}

type PrevNight = {
	day: string
	manifest: PacedD1NightManifest
	manifestSha256: string
	indexLocation: 'sealed' | 'staging'
}

export type D1PacedBackupTickMode = 'nightly' | 'catch-up' | 'operator'

export type D1PacedBackupTickResult = {
	day: string
	mode: D1PacedBackupTickMode
	skipped: boolean
	reason?: string
	timeBudgetExhausted: boolean
	sourcesWorked: number
	tablesCompleted: number
	manifestsWritten: number
	nightsSealed: number
	bindingsMissing: number
}

export type D1PacedBackupWatchdogResult = {
	day: string
	skipped: boolean
	reason?: string
	incompleteSources: number
	missingSealedSources: number
	configuredSources: number
	expectedSealedDay: string
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function utcDayMinus(day: string, daysBack: number) {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return date.toISOString().slice(0, 10)
}

function pacedD1StagingNightMetaKey(day: string, databaseName: string) {
	return `${pacedD1StagingPrefix(day, databaseName)}night-meta.json`
}

function pacedD1StagingTableManifestKey(
	day: string,
	databaseName: string,
	table: string,
) {
	return `${pacedD1StagingPrefix(day, databaseName)}table-manifests/${encodeURIComponent(table)}.json`
}

function pacedD1LaneProgressKey(day: string) {
	return `staging/${day}/d1-paced/lane-progress.json`
}

/**
 * Tick-local writer: only the current part's lines live in memory. Callers
 * flush to staging part objects whenever `bufferedBytes` crosses
 * `d1PacedBackupPartMaxBytes`, then `clear()` so heap stays bounded.
 *
 * `finalize()` hashes only the residual buffer (normally empty after a flush).
 * Full table digests come from `finalizeTableParts` over part objects.
 */
function createTickTableWriter(): PacedD1TableArtifactWriter & {
	data: string
	index: string
	bufferedBytes: number
	isEmpty(): boolean
	clear(): void
} {
	const state = { data: '', index: '', dataBytes: 0, indexBytes: 0 }
	return {
		get data() {
			return state.data
		},
		get index() {
			return state.index
		},
		get bufferedBytes() {
			return state.dataBytes + state.indexBytes
		},
		isEmpty() {
			return state.dataBytes === 0 && state.indexBytes === 0
		},
		clear() {
			state.data = ''
			state.index = ''
			state.dataBytes = 0
			state.indexBytes = 0
		},
		appendData(line: string) {
			state.data += line
			state.dataBytes += utf8ByteLength(line)
		},
		appendIndex(line: string) {
			state.index += line
			state.indexBytes += utf8ByteLength(line)
		},
		async finalize() {
			// Hash only the residual part buffer — never re-encode a multi-MB
			// accumulation. Callers must flush oversized buffers before this.
			return {
				dataSha256: await sha256HexOfText(state.data),
				indexSha256: await sha256HexOfText(state.index),
			}
		},
	}
}
async function readTimeTravelBookmark(db: D1Database): Promise<string | null> {
	try {
		if (typeof db.withSession !== 'function') return null
		const session = db.withSession()
		// Workers return null from getBookmark() until the session has run a
		// query; a cheap SELECT materializes the bookmark for the night meta.
		await session.prepare('SELECT 1 AS ok').first()
		const bookmark = session.getBookmark()
		return typeof bookmark === 'string' && bookmark.trim().length > 0
			? bookmark
			: null
	} catch {
		return null
	}
}

async function flushTablePart(input: {
	s3: DrBackupS3Client
	day: string
	databaseName: string
	table: string
	partIndex: number
	data: string
	index: string
}) {
	await Promise.all([
		input.s3.put(
			pacedD1StagingDataPartKey(
				input.day,
				input.databaseName,
				input.table,
				input.partIndex,
			),
			input.data,
			{ contentType: 'text/tab-separated-values' },
		),
		input.s3.put(
			pacedD1StagingIndexPartKey(
				input.day,
				input.databaseName,
				input.table,
				input.partIndex,
			),
			input.index,
			{ contentType: 'text/tab-separated-values' },
		),
	])
}

/**
 * Hash part files into a staging parts-pointer. Always keeps parts only —
 * never assembles a monolithic TSV (that doubled peak memory and OOMed
 * catch-up/seal ticks on large APP/AUDIT tables).
 */
async function finalizeTableParts(input: {
	s3: DrBackupS3Client
	day: string
	databaseName: string
	table: string
	partCount: number
}): Promise<{ dataSha256: string; indexSha256: string }> {
	if (input.partCount <= 0) {
		await Promise.all([
			input.s3.put(
				pacedD1StagingDataKey(input.day, input.databaseName, input.table),
				'',
				{ contentType: 'text/tab-separated-values' },
			),
			input.s3.put(
				pacedD1StagingIndexKey(input.day, input.databaseName, input.table),
				'',
				{ contentType: 'text/tab-separated-values' },
			),
		])
		const empty = await sha256HexOfText('')
		return { dataSha256: empty, indexSha256: empty }
	}

	const dataPartDigests: Array<string> = []
	const indexPartDigests: Array<string> = []

	for (let partIndex = 0; partIndex < input.partCount; partIndex += 1) {
		// Sequential fetches: one part body in memory at a time.
		const dataBytes = await input.s3.getBytes(
			pacedD1StagingDataPartKey(
				input.day,
				input.databaseName,
				input.table,
				partIndex,
			),
		)
		if (!dataBytes) {
			throw new Error(
				`paced D1 missing staging data part ${partIndex} for ${input.databaseName}.${input.table}`,
			)
		}
		dataPartDigests.push(await sha256HexOfBytes(dataBytes))

		const indexBytes = await input.s3.getBytes(
			pacedD1StagingIndexPartKey(
				input.day,
				input.databaseName,
				input.table,
				partIndex,
			),
		)
		if (!indexBytes) {
			throw new Error(
				`paced D1 missing staging index part ${partIndex} for ${input.databaseName}.${input.table}`,
			)
		}
		indexPartDigests.push(await sha256HexOfBytes(indexBytes))
	}

	const dataSha256 = await sha256HexOfText(`${dataPartDigests.join('\n')}\n`)
	const indexSha256 = await sha256HexOfText(`${indexPartDigests.join('\n')}\n`)
	const pointer = `${JSON.stringify({
		schemaVersion: pacedD1BackupSchemaVersion,
		kind: 'paced-d1-parts',
		partCount: input.partCount,
		dataSha256,
		indexSha256,
		dataPartDigests,
		indexPartDigests,
	})}\n`
	await Promise.all([
		input.s3.put(
			pacedD1StagingDataKey(input.day, input.databaseName, input.table),
			pointer,
			{ contentType: 'application/json' },
		),
		input.s3.put(
			pacedD1StagingIndexKey(input.day, input.databaseName, input.table),
			pointer,
			{ contentType: 'application/json' },
		),
	])
	return { dataSha256, indexSha256 }
}

async function loadPreviousNight(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
}): Promise<PrevNight | null> {
	const prevDay = utcDayMinus(input.day, 1)
	const tier = pacedD1RetentionTierForDay(prevDay)
	const sealedKey = pacedD1SealedManifestKey(tier, input.source.id, prevDay)
	const sealed = await input.s3.getText(sealedKey)
	if (sealed) {
		try {
			const manifest = parsePacedD1NightManifest(JSON.parse(sealed.text))
			return {
				day: prevDay,
				manifest,
				manifestSha256: await sha256HexOfText(sealed.text),
				indexLocation: 'sealed',
			}
		} catch {
			// Fall through to staging.
		}
	}
	const staging = await input.s3.getText(
		pacedD1StagingManifestKey(prevDay, input.source.name),
	)
	if (!staging) return null
	try {
		const manifest = parsePacedD1NightManifest(JSON.parse(staging.text))
		return {
			day: prevDay,
			manifest,
			manifestSha256: await sha256HexOfText(staging.text),
			indexLocation: 'staging',
		}
	} catch {
		return null
	}
}

/**
 * Stream previous-night index parts one file at a time so AUDIT-sized indexes
 * never load into the worker heap for a delta merge-join.
 */
function createPartsIndexReader(input: {
	s3: DrBackupS3Client
	partCount: number
	partKey: (partIndex: number) => string
	label: string
}) {
	let partIndex = 0
	let lines: Array<string> = []
	let lineIndex = 0
	let cur: PacedD1IndexEntry | null = null
	let done = input.partCount === 0

	const refill = async () => {
		while (lineIndex >= lines.length && partIndex < input.partCount) {
			const bytes = await input.s3.getBytes(input.partKey(partIndex))
			if (!bytes) {
				throw new Error(
					`paced D1 missing index part ${partIndex} for ${input.label}`,
				)
			}
			partIndex += 1
			const text = new TextDecoder().decode(bytes)
			lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
			lineIndex = 0
		}
		if (lineIndex >= lines.length && partIndex >= input.partCount) {
			done = true
		}
	}

	return {
		async peek() {
			if (cur || done) return cur
			await refill()
			if (done || lineIndex >= lines.length) {
				done = true
				return null
			}
			cur = parsePacedD1IndexLine(lines[lineIndex++]!)
			return cur
		},
		take() {
			const value = cur
			if (!value) throw new Error('paced D1 index reader take() without peek')
			cur = null
			return value
		},
	}
}

async function openPrevIndex(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	prev: PrevNight
	table: string
}) {
	const tier = pacedD1RetentionTierForDay(input.prev.day)
	const key =
		input.prev.indexLocation === 'sealed'
			? pacedD1SealedIndexKey(
					tier,
					input.source.id,
					input.prev.day,
					input.table,
				)
			: pacedD1StagingIndexKey(input.prev.day, input.source.name, input.table)
	const text = await input.s3.getText(key)
	const body = text?.text ?? ''
	const pointer = parsePacedD1PartsPointer(body)
	if (pointer) {
		const label = `${input.source.name}.${input.table}`
		if (input.prev.indexLocation === 'sealed') {
			return createPartsIndexReader({
				s3: input.s3,
				partCount: pointer.partCount,
				label,
				partKey: (partIndex) =>
					pacedD1SealedIndexPartKey(
						tier,
						input.source.id,
						input.prev.day,
						input.table,
						partIndex,
					),
			})
		}
		return createPartsIndexReader({
			s3: input.s3,
			partCount: pointer.partCount,
			label,
			partKey: (partIndex) =>
				pacedD1StagingIndexPartKey(
					input.prev.day,
					input.source.name,
					input.table,
					partIndex,
				),
		})
	}
	return createMemoryPacedD1IndexReader(body)
}

async function loadOrCreateNightMeta(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	db: D1Database
	day: string
	now: Date
	prev: PrevNight | null
	schema: PacedD1SchemaSnapshot
}): Promise<NightMeta> {
	const key = pacedD1StagingNightMetaKey(input.day, input.source.name)
	const existing = await input.s3.getText(key)
	if (existing) {
		const parsed = JSON.parse(existing.text) as NightMeta
		if (
			parsed.schemaVersion === pacedD1BackupSchemaVersion &&
			parsed.day === input.day &&
			parsed.databaseName === input.source.name
		) {
			if (parsed.schemaHash !== input.schema.schemaHash) {
				parsed.schemaStableDuringWalk = false
			}
			return parsed
		}
	}
	const meta: NightMeta = {
		schemaVersion: pacedD1BackupSchemaVersion,
		day: input.day,
		databaseName: input.source.name,
		databaseId: input.source.id,
		startedAt: input.now.toISOString(),
		prevDay: input.prev?.day ?? null,
		prevManifestSha256: input.prev?.manifestSha256 ?? null,
		schemaHash: input.schema.schemaHash,
		schemaStableDuringWalk: true,
		timeTravelBookmark: await readTimeTravelBookmark(input.db),
		extras: input.schema.extras,
		sqliteSequence: input.schema.sqliteSequence,
		queries: 0,
		rowsRead: 0,
		d1RowsRead: 0,
		bytesOut: 0,
		queryMs: [],
		wallStartedAtMs: Date.now(),
	}
	await input.s3.put(key, `${JSON.stringify(meta)}\n`, {
		contentType: 'application/json',
	})
	return meta
}

async function persistNightMeta(s3: DrBackupS3Client, meta: NightMeta) {
	await s3.put(
		pacedD1StagingNightMetaKey(meta.day, meta.databaseName),
		`${JSON.stringify(meta)}\n`,
		{ contentType: 'application/json' },
	)
}

async function loadProgress(
	s3: DrBackupS3Client,
	day: string,
	databaseName: string,
): Promise<PacedD1ProgressCursor | null> {
	const raw = await s3.getText(pacedD1StagingProgressKey(day, databaseName))
	if (!raw) return null
	try {
		return parsePacedD1ProgressCursor(JSON.parse(raw.text))
	} catch {
		return null
	}
}

async function persistProgress(
	s3: DrBackupS3Client,
	progress: PacedD1ProgressCursor,
) {
	await s3.put(
		pacedD1StagingProgressKey(progress.day, progress.databaseName),
		`${JSON.stringify(progress)}\n`,
		{ contentType: 'application/json' },
	)
}

async function clearProgress(
	s3: DrBackupS3Client,
	day: string,
	databaseName: string,
) {
	// Staging is mutable; overwrite progress with a tombstone-free delete via
	// empty object is not available on the S3 helper — leave key absent by
	// writing a terminal marker only when replaced by manifest. Callers stop
	// reading progress once the staging manifest exists.
	await s3.put(
		pacedD1StagingProgressKey(day, databaseName),
		`${JSON.stringify({ cleared: true, day, databaseName })}\n`,
		{ contentType: 'application/json' },
	)
}

async function loadLaneProgress(
	s3: DrBackupS3Client,
	day: string,
): Promise<LaneProgress> {
	const raw = await s3.getText(pacedD1LaneProgressKey(day))
	if (raw) {
		try {
			const parsed = JSON.parse(raw.text) as LaneProgress
			if (
				parsed.schemaVersion === pacedD1BackupSchemaVersion &&
				parsed.day === day &&
				Number.isSafeInteger(parsed.nextSourceIndex)
			) {
				return parsed
			}
		} catch {
			// Recreate.
		}
	}
	return {
		schemaVersion: pacedD1BackupSchemaVersion,
		day,
		nextSourceIndex: 0,
	}
}

async function persistLaneProgress(s3: DrBackupS3Client, lane: LaneProgress) {
	await s3.put(pacedD1LaneProgressKey(lane.day), `${JSON.stringify(lane)}\n`, {
		contentType: 'application/json',
	})
}

async function sourceHasManifest(
	s3: DrBackupS3Client,
	day: string,
	databaseName: string,
) {
	const head = await s3.head(pacedD1StagingManifestKey(day, databaseName))
	return head.exists
}

/** Crashed mid-flight: progress or night-meta without a finished manifest. */
async function sourceHasInProgressWork(
	s3: DrBackupS3Client,
	day: string,
	databaseName: string,
) {
	if (await sourceHasManifest(s3, day, databaseName)) return false
	const progress = await s3.head(pacedD1StagingProgressKey(day, databaseName))
	const meta = await s3.head(pacedD1StagingNightMetaKey(day, databaseName))
	return progress.exists || meta.exists
}

async function sourceNeedsManifest(
	s3: DrBackupS3Client,
	day: string,
	databaseName: string,
) {
	return !(await sourceHasManifest(s3, day, databaseName))
}

async function sourceNeedsSeal(
	s3: DrBackupS3Client,
	source: PacedD1SourceConfig,
	day: string,
) {
	if (!(await sourceHasManifest(s3, day, source.name))) return false
	return !(await sourceHasSealedManifest(s3, source, day))
}

/**
 * Oldest unfinished night first: crashed mid-walk, staging without seal, then
 * today when any bound source still lacks a staging manifest. Catch-up must
 * reseal failed seals — staging alone is not "done".
 */
async function findStrandedPacedDay(input: {
	s3: DrBackupS3Client
	today: string
	lookbackDays: number
	sources: Array<PacedD1SourceConfig>
	env: Env
}): Promise<string | null> {
	for (let offset = input.lookbackDays; offset >= 1; offset -= 1) {
		const candidate = utcDayMinus(input.today, offset)
		for (const source of input.sources) {
			if (!resolvePacedD1Binding(input.env, source.binding)) continue
			if (await sourceHasInProgressWork(input.s3, candidate, source.name)) {
				return candidate
			}
			if (await sourceNeedsSeal(input.s3, source, candidate)) {
				return candidate
			}
		}
	}
	for (const source of input.sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) continue
		if (await sourceNeedsManifest(input.s3, input.today, source.name)) {
			return input.today
		}
		if (await sourceNeedsSeal(input.s3, source, input.today)) {
			return input.today
		}
	}
	return null
}

function createInitialProgress(input: {
	day: string
	source: PacedD1SourceConfig
	schema: PacedD1SchemaSnapshot
	now: Date
	prev: PrevNight | null
}): PacedD1ProgressCursor {
	return {
		schemaVersion: pacedD1BackupSchemaVersion,
		day: input.day,
		databaseName: input.source.name,
		databaseId: input.source.id,
		retentionTier: pacedD1RetentionTierForDay(input.day),
		startedAt: input.now.toISOString(),
		prevDay: input.prev?.day ?? null,
		prevManifestSha256: input.prev?.manifestSha256 ?? null,
		schemaHash: input.schema.schemaHash,
		completedTables: [],
		currentTable: null,
		lastRowid: null,
		pageSize: 50,
		partialUpserts: 0,
		partialDeletes: 0,
		partialCount: 0,
		partialChecksum: '0000000000000000',
		revision: 0,
		partCount: 0,
	}
}

async function finalizeSourceNight(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	schema: PacedD1SchemaSnapshot
	meta: NightMeta
	progress: PacedD1ProgressCursor
	startedAtMs?: number
	timeBudgetMs?: number
}): Promise<{ sealed: boolean }> {
	const tables: Record<string, PacedD1TableManifest> = {}
	for (const tableName of input.progress.completedTables) {
		const raw = await input.s3.getText(
			pacedD1StagingTableManifestKey(input.day, input.source.name, tableName),
		)
		if (!raw) {
			throw new Error(
				`paced D1 missing table manifest for ${input.source.name}.${tableName}`,
			)
		}
		tables[tableName] = JSON.parse(raw.text) as PacedD1TableManifest
	}
	const wallMs = Math.max(1, Date.now() - input.meta.wallStartedAtMs)
	const { manifest } = await buildPacedD1NightManifest({
		databaseName: input.source.name,
		databaseId: input.source.id,
		day: input.day,
		startedAt: input.meta.startedAt,
		finishedAt: new Date().toISOString(),
		prevDay: input.meta.prevDay,
		prevManifestSha256: input.meta.prevManifestSha256,
		schema: {
			...input.schema,
			extras: input.meta.extras,
			sqliteSequence: input.meta.sqliteSequence,
			schemaHash: input.meta.schemaHash,
		},
		schemaStableDuringWalk: input.meta.schemaStableDuringWalk,
		timeTravelBookmark: input.meta.timeTravelBookmark,
		tables,
		stats: summarizePacedQueryMs(input.meta.queryMs, wallMs, {
			queries: input.meta.queries,
			rowsRead: input.meta.rowsRead,
			d1RowsRead: input.meta.d1RowsRead,
			bytesOut: input.meta.bytesOut,
		}),
		shadow: true,
	})
	await input.s3.put(
		pacedD1StagingManifestKey(input.day, input.source.name),
		`${JSON.stringify(manifest, null, 1)}\n`,
		{ contentType: 'application/json' },
	)
	await clearProgress(input.s3, input.day, input.source.name)
	const sealed = await sealPacedD1SourceNight({
		s3: input.s3,
		source: input.source,
		day: input.day,
		manifest,
		startedAtMs: input.startedAtMs ?? input.meta.wallStartedAtMs,
		timeBudgetMs: input.timeBudgetMs,
	})
	return { sealed: sealed.complete }
}

async function sourceHasSealedManifest(
	s3: DrBackupS3Client,
	source: PacedD1SourceConfig,
	day: string,
) {
	const tier = pacedD1RetentionTierForDay(day)
	const head = await s3.head(pacedD1SealedManifestKey(tier, source.id, day))
	return head.exists
}

async function ensureSourceSealed(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	startedAtMs?: number
	timeBudgetMs?: number
}): Promise<boolean> {
	if (await sourceHasSealedManifest(input.s3, input.source, input.day)) {
		return false
	}
	if (!(await sourceHasManifest(input.s3, input.day, input.source.name))) {
		return false
	}
	const sealed = await sealPacedD1SourceNight({
		s3: input.s3,
		source: input.source,
		day: input.day,
		startedAtMs: input.startedAtMs,
		timeBudgetMs: input.timeBudgetMs,
	})
	return sealed.complete
}

async function workSourceTick(input: {
	env: Env
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	db: D1Database
	day: string
	now: Date
	startedAtMs: number
	timeBudgetMs: number
	walkerOpts?: Partial<PacedD1WalkerOptions>
	partMaxBytes?: number
	tickByteBudget?: number
}): Promise<{
	timeBudgetExhausted: boolean
	tablesCompleted: number
	manifestWritten: boolean
	nightSealed: boolean
}> {
	let tablesCompleted = 0
	let manifestWritten = false
	let nightSealed = false
	if (await sourceHasManifest(input.s3, input.day, input.source.name)) {
		nightSealed = await ensureSourceSealed({
			s3: input.s3,
			source: input.source,
			day: input.day,
			startedAtMs: input.startedAtMs,
			timeBudgetMs: input.timeBudgetMs,
		})
		return {
			timeBudgetExhausted: !nightSealed,
			tablesCompleted,
			manifestWritten,
			nightSealed,
		}
	}

	const schema = await discoverPacedD1Schema(input.db as PacedD1Database)
	const prev = await loadPreviousNight({
		s3: input.s3,
		source: input.source,
		day: input.day,
	})
	const meta = await loadOrCreateNightMeta({
		s3: input.s3,
		source: input.source,
		db: input.db,
		day: input.day,
		now: input.now,
		prev,
		schema,
	})
	let progress =
		(await loadProgress(input.s3, input.day, input.source.name)) ??
		createInitialProgress({
			day: input.day,
			source: input.source,
			schema,
			now: input.now,
			prev,
		})

	const remainingTables = schema.tables.filter(
		(table) => !progress.completedTables.includes(table.name),
	)

	const pickNext = (): PacedD1DiscoveredTable | null => {
		if (progress.currentTable) {
			return (
				remainingTables.find((table) => table.name === progress.currentTable) ??
				null
			)
		}
		return remainingTables[0] ?? null
	}

	while (true) {
		const budgetLeft = input.timeBudgetMs - (Date.now() - input.startedAtMs)
		if (budgetLeft <= 0) {
			await persistProgress(input.s3, progress)
			await persistNightMeta(input.s3, meta)
			return {
				timeBudgetExhausted: true,
				tablesCompleted,
				manifestWritten,
				nightSealed,
			}
		}

		const table = pickNext()
		if (!table) {
			const finalized = await finalizeSourceNight({
				s3: input.s3,
				source: input.source,
				day: input.day,
				schema,
				meta,
				progress,
				startedAtMs: input.startedAtMs,
				timeBudgetMs: input.timeBudgetMs,
			})
			manifestWritten = true
			nightSealed = finalized.sealed
			return {
				timeBudgetExhausted: !finalized.sealed,
				tablesCompleted,
				manifestWritten,
				nightSealed,
			}
		}

		// Table manifest is the commit point for a finished table. If a prior
		// tick wrote it and then died before advancing progress, adopt it.
		const existingTableManifest = await input.s3.head(
			pacedD1StagingTableManifestKey(input.day, input.source.name, table.name),
		)
		if (existingTableManifest.exists) {
			progress = {
				...progress,
				completedTables: [...progress.completedTables, table.name],
				currentTable: null,
				lastRowid: null,
				partialUpserts: 0,
				partialDeletes: 0,
				partialCount: 0,
				partialChecksum: '0000000000000000',
				partCount: 0,
				revision: progress.revision + 1,
			}
			const idx = remainingTables.findIndex(
				(entry) => entry.name === table.name,
			)
			if (idx >= 0) remainingTables.splice(idx, 1)
			tablesCompleted += 1
			await persistProgress(input.s3, progress)
			await persistNightMeta(input.s3, meta)
			continue
		}

		const prevTable = prev?.manifest.tables[table.name]
		const mode = resolvePacedD1TableMode({
			day: input.day,
			tableSchemaHash: table.schemaHash,
			prevSchemaHash: prevTable?.schemaHash,
		})

		// Mid-table resume: lastRowid set. Walk-complete-pending-finalize:
		// currentTable set, lastRowid null, partCount > 0 (before-finalize
		// flushed trailing deletes; must not re-walk or those D lines duplicate).
		const sameTable = progress.currentTable === table.name
		const walkCompletePendingFinalize =
			sameTable && progress.lastRowid === null && progress.partCount > 0
		const resuming = sameTable && progress.lastRowid !== null
		let partCount = sameTable ? progress.partCount : 0
		const writer = createTickTableWriter()
		let tickBytesFlushed = 0
		let stopForByteBudget = false
		const partMaxBytes = input.partMaxBytes ?? d1PacedBackupPartMaxBytes
		const tickByteBudget = input.tickByteBudget ?? d1PacedBackupTickByteBudget

		const flushBufferedPart = async (
			cursor: {
				lastRowid: number | null
				pageSize: number
				count: number
				checksum: string
				upserts: number
				deletes: number
			},
			persistMode: 'resume' | 'walk-complete',
		) => {
			if (writer.isEmpty()) return
			// Single oversized row: still flush alone so the buffer clears.
			const partBytes = writer.bufferedBytes
			await flushTablePart({
				s3: input.s3,
				day: input.day,
				databaseName: input.source.name,
				table: table.name,
				partIndex: partCount,
				data: writer.data,
				index: writer.index,
			})
			partCount += 1
			tickBytesFlushed += partBytes
			writer.clear()
			// Persist after every part. Mid-walk keeps lastRowid for resume.
			// before-finalize clears lastRowid so a crash cannot re-emit the
			// trailing delete lines already in this part.
			progress = {
				...progress,
				currentTable: table.name,
				lastRowid: persistMode === 'walk-complete' ? null : cursor.lastRowid,
				pageSize: cursor.pageSize,
				partialCount: cursor.count,
				partialChecksum: cursor.checksum,
				partialUpserts: cursor.upserts,
				partialDeletes: cursor.deletes,
				partCount,
				revision: progress.revision + 1,
			}
			await persistProgress(input.s3, progress)
			await persistNightMeta(input.s3, meta)
			if (tickBytesFlushed >= tickByteBudget) {
				stopForByteBudget = true
			}
		}

		if (walkCompletePendingFinalize) {
			const hashes = await finalizeTableParts({
				s3: input.s3,
				day: input.day,
				databaseName: input.source.name,
				table: table.name,
				partCount,
			})
			const selCols = ['__rowid', ...table.cols]
			const tableManifest: PacedD1TableManifest = {
				mode,
				schemaHash: table.schemaHash,
				sql: table.sql,
				cols: selCols,
				pk: ['rowid'],
				declaredPk: table.declaredPk,
				count: progress.partialCount,
				checksum: progress.partialChecksum,
				upserts: progress.partialUpserts,
				deletes: progress.partialDeletes,
				dataSha256: hashes.dataSha256,
				indexSha256: hashes.indexSha256,
			}
			await input.s3.put(
				pacedD1StagingTableManifestKey(
					input.day,
					input.source.name,
					table.name,
				),
				`${JSON.stringify(tableManifest)}\n`,
				{ contentType: 'application/json' },
			)
			progress = {
				...progress,
				completedTables: [...progress.completedTables, table.name],
				currentTable: null,
				lastRowid: null,
				partialUpserts: 0,
				partialDeletes: 0,
				partialCount: 0,
				partialChecksum: '0000000000000000',
				partCount: 0,
				revision: progress.revision + 1,
			}
			const idx = remainingTables.findIndex(
				(entry) => entry.name === table.name,
			)
			if (idx >= 0) remainingTables.splice(idx, 1)
			tablesCompleted += 1
			await persistProgress(input.s3, progress)
			await persistNightMeta(input.s3, meta)
			continue
		}

		const hostWalkerOpts = input.walkerOpts ?? {}
		const result = await walkPacedD1Table({
			db: input.db as PacedD1Database,
			table,
			mode,
			prev:
				mode === 'delta' && prevTable
					? {
							schemaHash: prevTable.schemaHash,
							openIndex: () =>
								openPrevIndex({
									s3: input.s3,
									source: input.source,
									prev: prev!,
									table: table.name,
								}),
						}
					: null,
			writer,
			startAfterRowid: resuming ? progress.lastRowid : null,
			initialPageSize: sameTable ? progress.pageSize : undefined,
			partial: resuming
				? {
						count: progress.partialCount,
						checksum: progress.partialChecksum,
						upserts: progress.partialUpserts,
						deletes: progress.partialDeletes,
					}
				: undefined,
			opts: {
				...hostWalkerOpts,
				budgetMs: hostWalkerOpts.budgetMs ?? budgetLeft,
				budgetBytes: hostWalkerOpts.budgetBytes ?? tickByteBudget,
				shouldStop: () =>
					stopForByteBudget || hostWalkerOpts.shouldStop?.() === true,
				onPage: async (info) => {
					await hostWalkerOpts.onPage?.(info)
					const overCap = writer.bufferedBytes >= partMaxBytes
					const beforeFinalize = info.phase === 'before-finalize'
					if (!overCap && !beforeFinalize) return
					if (writer.isEmpty()) return
					if (beforeFinalize) {
						await flushBufferedPart(info, 'walk-complete')
						return
					}
					if (info.lastRowid !== null) {
						await flushBufferedPart(info, 'resume')
						return
					}
					// Empty-table / no-rowid mid-cap edge: flush bytes, then
					// mark walk-complete so resume does not reset partCount.
					await flushBufferedPart(info, 'walk-complete')
				},
			},
		})

		meta.queries += result.queries
		meta.rowsRead += result.rowsRead
		meta.d1RowsRead += result.d1RowsRead
		meta.bytesOut += result.bytesOut
		meta.queryMs.push(...result.queryMs)

		if (!writer.isEmpty()) {
			await flushBufferedPart(
				result.done
					? {
							lastRowid: null,
							pageSize: progress.pageSize,
							count: result.manifest.count,
							checksum: result.manifest.checksum,
							upserts: result.manifest.upserts,
							deletes: result.manifest.deletes,
						}
					: {
							lastRowid: result.lastRowid,
							pageSize: result.pageSize,
							count: result.count,
							checksum: result.checksum,
							upserts: result.upserts,
							deletes: result.deletes,
						},
				result.done ? 'walk-complete' : 'resume',
			)
		}

		if (!result.done) {
			// Part files are written first (same part index is overwritten on
			// retry). Progress is the resume commit point and must land after.
			progress = {
				...progress,
				currentTable: table.name,
				lastRowid: result.lastRowid,
				pageSize: result.pageSize,
				partialCount: result.count,
				partialChecksum: result.checksum,
				partialUpserts: result.upserts,
				partialDeletes: result.deletes,
				partCount,
				revision: progress.revision + 1,
			}
			await persistProgress(input.s3, progress)
			await persistNightMeta(input.s3, meta)
			return {
				timeBudgetExhausted: true,
				tablesCompleted,
				manifestWritten,
				nightSealed,
			}
		}

		const hashes = await finalizeTableParts({
			s3: input.s3,
			day: input.day,
			databaseName: input.source.name,
			table: table.name,
			partCount,
		})
		const tableManifest: PacedD1TableManifest = {
			...result.manifest,
			dataSha256: hashes.dataSha256,
			indexSha256: hashes.indexSha256,
		}
		await input.s3.put(
			pacedD1StagingTableManifestKey(input.day, input.source.name, table.name),
			`${JSON.stringify(tableManifest)}\n`,
			{ contentType: 'application/json' },
		)
		progress = {
			...progress,
			completedTables: [...progress.completedTables, table.name],
			currentTable: null,
			lastRowid: null,
			partialUpserts: 0,
			partialDeletes: 0,
			partialCount: 0,
			partialChecksum: '0000000000000000',
			partCount: 0,
			revision: progress.revision + 1,
		}
		// Drop finished table from the local remaining list.
		const idx = remainingTables.findIndex((entry) => entry.name === table.name)
		if (idx >= 0) remainingTables.splice(idx, 1)
		tablesCompleted += 1
		await persistProgress(input.s3, progress)
		await persistNightMeta(input.s3, meta)
	}
}

export async function runD1PacedBackupTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
	day?: string
	timeBudgetMs?: number
	walkerOpts?: Partial<PacedD1WalkerOptions>
	/** Test override for mid-tick part flush threshold (UTF-8 bytes). */
	partMaxBytes?: number
	/** Test override for soft per-tick emitted-byte budget. */
	tickByteBudget?: number
}): Promise<D1PacedBackupTickResult> {
	const now = input.now
	const today = formatUtcDay(now)
	const mode: D1PacedBackupTickMode =
		input.day !== undefined
			? 'operator'
			: shouldRunD1PacedBackupCron(now)
				? 'nightly'
				: 'catch-up'
	let day = input.day ?? today
	const empty = (reason: string): D1PacedBackupTickResult => ({
		day,
		mode,
		skipped: true,
		reason,
		timeBudgetExhausted: false,
		sourcesWorked: 0,
		tablesCompleted: 0,
		manifestsWritten: 0,
		nightsSealed: 0,
		bindingsMissing: 0,
	})

	if (mode === 'catch-up' && !shouldRunD1PacedBackupCatchUpCron(now)) {
		return empty('outside-nightly-window')
	}
	if (!isD1PacedBackupConfigured(input.env)) {
		return empty('not-configured')
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) return empty('not-configured')

	let sources: Array<PacedD1SourceConfig>
	try {
		sources = parseD1PacedSources(input.env.DR_D1_PACED_SOURCES)
	} catch (error) {
		return empty(
			error instanceof Error ? error.message : 'invalid-paced-sources',
		)
	}
	if (sources.length === 0) {
		return empty('sources-unset')
	}

	const s3 = input.s3 ?? createDrBackupS3Client(config)
	if (mode === 'nightly' || mode === 'catch-up') {
		const stranded = await findStrandedPacedDay({
			s3,
			today,
			lookbackDays: d1PacedBackupCatchUpLookbackDays,
			sources,
			env: input.env,
		})
		if (stranded) {
			day = stranded
		} else if (mode === 'catch-up') {
			return empty('no-stranded-day')
		}
	}

	const timeBudgetMs = input.timeBudgetMs ?? d1PacedBackupRunTimeBudgetMs
	const startedAtMs = Date.now()

	// Cheap exit when every bound source already finished and sealed tonight.
	// Seal may span ticks under the time budget (large APP/AUDIT nights).
	let allDone = true
	let bindingsMissing = 0
	let nightsSealed = 0
	for (const source of sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) {
			bindingsMissing += 1
			continue
		}
		if (!(await sourceHasManifest(s3, day, source.name))) {
			allDone = false
			continue
		}
		if (await sourceHasSealedManifest(s3, source, day)) {
			continue
		}
		allDone = false
		if (
			await ensureSourceSealed({
				s3,
				source,
				day,
				startedAtMs,
				timeBudgetMs,
			})
		) {
			nightsSealed += 1
		}
	}
	if (allDone) {
		return {
			day,
			mode,
			skipped: nightsSealed === 0,
			reason: nightsSealed === 0 ? 'already-complete' : undefined,
			timeBudgetExhausted: false,
			sourcesWorked: 0,
			tablesCompleted: 0,
			manifestsWritten: 0,
			nightsSealed,
			bindingsMissing,
		}
	}

	const lane = await loadLaneProgress(s3, day)
	let sourcesWorked = 0
	let tablesCompleted = 0
	let manifestsWritten = 0
	let timeBudgetExhausted = false

	for (let offset = 0; offset < sources.length; offset += 1) {
		const index = (lane.nextSourceIndex + offset) % sources.length
		const source = sources[index]!
		const db = resolvePacedD1Binding(input.env, source.binding)
		if (!db) {
			continue
		}
		const alreadyManifest = await sourceHasManifest(s3, day, source.name)
		const alreadySealed = alreadyManifest
			? await sourceHasSealedManifest(s3, source, day)
			: false
		if (alreadyManifest && alreadySealed) continue

		const result = await workSourceTick({
			env: input.env,
			s3,
			source,
			db,
			day,
			now,
			startedAtMs,
			timeBudgetMs,
			walkerOpts: input.walkerOpts,
			partMaxBytes: input.partMaxBytes,
			tickByteBudget: input.tickByteBudget,
		})
		sourcesWorked += 1
		tablesCompleted += result.tablesCompleted
		if (result.manifestWritten) manifestsWritten += 1
		if (result.nightSealed) nightsSealed += 1
		lane.nextSourceIndex = (index + 1) % sources.length
		await persistLaneProgress(s3, lane)
		if (result.timeBudgetExhausted) {
			timeBudgetExhausted = true
			break
		}
		if (Date.now() - startedAtMs >= timeBudgetMs) {
			timeBudgetExhausted = true
			break
		}
	}

	const tickResult: D1PacedBackupTickResult = {
		day,
		mode,
		skipped: false,
		timeBudgetExhausted,
		sourcesWorked,
		tablesCompleted,
		manifestsWritten,
		nightsSealed,
		bindingsMissing,
	}
	console.info('dr_d1_paced_backup_tick', JSON.stringify(tickResult))
	return tickResult
}

/**
 * After the nightly window: require staging + sealed manifests for today.
 * Also require yesterday's sealed night so a missed seal cannot rot quietly.
 */
export async function runD1PacedBackupWatchdogTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
}): Promise<D1PacedBackupWatchdogResult> {
	const day = formatUtcDay(input.now)
	const expectedSealedDay = day
	const yesterday = utcDayMinus(day, 1)
	if (!isD1PacedBackupConfigured(input.env)) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			missingSealedSources: 0,
			configuredSources: 0,
			expectedSealedDay,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			missingSealedSources: 0,
			configuredSources: 0,
			expectedSealedDay,
		}
	}
	const sources = parseD1PacedSources(input.env.DR_D1_PACED_SOURCES)
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	let incomplete = 0
	let missingSealed = 0
	let configured = 0
	const missing: Array<string> = []
	for (const source of sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) continue
		configured += 1
		const hasStaging = await sourceHasManifest(s3, day, source.name)
		const hasSealedToday = await sourceHasSealedManifest(s3, source, day)
		const hasSealedYesterday = await sourceHasSealedManifest(
			s3,
			source,
			yesterday,
		)
		if (!hasStaging) {
			incomplete += 1
			missing.push(`${source.name}:staging:${day}`)
		}
		if (!hasSealedToday) {
			missingSealed += 1
			missing.push(`${source.name}:sealed:${day}`)
		}
		// Yesterday seal is required only when yesterday staging existed (seal
		// lag). The first successful paced night must not page for a missing
		// yesterday that never ran.
		if (!hasSealedYesterday) {
			const yesterdayStaging = await sourceHasManifest(
				s3,
				yesterday,
				source.name,
			)
			if (yesterdayStaging) {
				missingSealed += 1
				missing.push(`${source.name}:sealed:${yesterday}`)
			}
		}
	}
	const ok = incomplete === 0 && missingSealed === 0
	const result: D1PacedBackupWatchdogResult = {
		day,
		skipped: ok,
		reason: ok ? 'complete' : undefined,
		incompleteSources: incomplete,
		missingSealedSources: missingSealed,
		configuredSources: configured,
		expectedSealedDay,
	}
	console.info('dr_d1_paced_backup_watchdog', JSON.stringify(result))
	if (!ok) {
		throw new Error(
			`paced D1 shadow backup incomplete for ${day}: staging missing ${incomplete}, sealed missing ${missingSealed} (${missing.join(', ')}) of ${configured} sources`,
		)
	}
	return result
}

/** Mid-day freshness: sealed paced night for yesterday must exist. */
export async function runD1PacedFreshnessTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
}): Promise<D1PacedBackupWatchdogResult> {
	const today = formatUtcDay(input.now)
	// Hourly freshness always floors on yesterday so enabling the lane mid-day
	// (after 06:15) does not page until a paced night has had a chance to run.
	// The 06:15 watchdog is what asserts today's seal after the nightly window.
	const expectedSealedDay = utcDayMinus(today, 1)
	if (!isD1PacedBackupConfigured(input.env)) {
		return {
			day: today,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			missingSealedSources: 0,
			configuredSources: 0,
			expectedSealedDay,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			day: today,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			missingSealedSources: 0,
			configuredSources: 0,
			expectedSealedDay,
		}
	}
	const sources = parseD1PacedSources(input.env.DR_D1_PACED_SOURCES)
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	let missingSealed = 0
	let configured = 0
	const missing: Array<string> = []
	for (const source of sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) continue
		configured += 1
		if (await sourceHasSealedManifest(s3, source, expectedSealedDay)) {
			continue
		}
		// No staging for that day means the lane never ran it (e.g. just
		// enabled) — do not page. Staging without seal is seal lag.
		if (!(await sourceHasManifest(s3, expectedSealedDay, source.name))) {
			continue
		}
		missingSealed += 1
		missing.push(source.name)
	}
	const result: D1PacedBackupWatchdogResult = {
		day: today,
		skipped: missingSealed === 0,
		reason: missingSealed === 0 ? 'fresh' : undefined,
		incompleteSources: 0,
		missingSealedSources: missingSealed,
		configuredSources: configured,
		expectedSealedDay,
	}
	console.info('dr_d1_paced_freshness', JSON.stringify(result))
	if (missingSealed > 0) {
		throw new Error(
			`paced D1 sealed night missing for ${expectedSealedDay}: ${missing.join(', ')} (${missingSealed}/${configured})`,
		)
	}
	return result
}

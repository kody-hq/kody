import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedIndexKey,
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

export {
	d1PacedBackupCatchUpLookbackDays,
	isD1PacedBackupConfigured,
	shouldRunD1PacedBackupCatchUpCron,
	shouldRunD1PacedBackupCron,
	shouldRunD1PacedBackupWatchdogCron,
} from '#worker/dr/d1-paced-backup-schedule.ts'
export {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceBinding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'

/** Wall budget for one paced D1 cron tick (same order as DR exporter). */
export const d1PacedBackupRunTimeBudgetMs = 45_000

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
	bindingsMissing: number
}

export type D1PacedBackupWatchdogResult = {
	day: string
	skipped: boolean
	reason?: string
	incompleteSources: number
	configuredSources: number
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
 * Tick-local writer: only the current cron tick's lines live in memory. Prior
 * pages stay in staging part objects so large tables (AUDIT_DB) never rewrite
 * a growing TSV through the worker heap.
 */
function createTickTableWriter(): PacedD1TableArtifactWriter & {
	data: string
	index: string
	isEmpty(): boolean
} {
	const state = { data: '', index: '' }
	return {
		get data() {
			return state.data
		},
		get index() {
			return state.index
		},
		isEmpty() {
			return state.data.length === 0 && state.index.length === 0
		},
		appendData(line: string) {
			state.data += line
		},
		appendIndex(line: string) {
			state.index += line
		},
		async finalize() {
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
 * Hash (and, when small enough, assemble) part files into the canonical
 * staging data/index keys. Large tables keep parts only — the seal/restore
 * path reads parts in order so the worker never holds the full TSV.
 */
const pacedD1AssembleMaxBytes = 8 * 1024 * 1024

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

	let totalBytes = 0
	const dataChunks: Array<Uint8Array> = []
	const indexChunks: Array<Uint8Array> = []
	const dataPartDigests: Array<string> = []
	const indexPartDigests: Array<string> = []
	let assemble = true

	for (let partIndex = 0; partIndex < input.partCount; partIndex += 1) {
		const [dataBytes, indexBytes] = await Promise.all([
			input.s3.getBytes(
				pacedD1StagingDataPartKey(
					input.day,
					input.databaseName,
					input.table,
					partIndex,
				),
			),
			input.s3.getBytes(
				pacedD1StagingIndexPartKey(
					input.day,
					input.databaseName,
					input.table,
					partIndex,
				),
			),
		])
		const data = dataBytes ?? new Uint8Array()
		const index = indexBytes ?? new Uint8Array()
		dataPartDigests.push(await sha256HexOfBytes(data))
		indexPartDigests.push(await sha256HexOfBytes(index))
		totalBytes += data.byteLength + index.byteLength
		if (assemble && totalBytes <= pacedD1AssembleMaxBytes) {
			dataChunks.push(data)
			indexChunks.push(index)
		} else {
			assemble = false
			dataChunks.length = 0
			indexChunks.length = 0
		}
	}

	if (assemble) {
		const dataBody = concatUtf8Chunks(dataChunks)
		const indexBody = concatUtf8Chunks(indexChunks)
		const [dataSha256, indexSha256] = await Promise.all([
			sha256HexOfBytes(dataBody),
			sha256HexOfBytes(indexBody),
		])
		await Promise.all([
			input.s3.put(
				pacedD1StagingDataKey(input.day, input.databaseName, input.table),
				dataBody,
				{ contentType: 'text/tab-separated-values' },
			),
			input.s3.put(
				pacedD1StagingIndexKey(input.day, input.databaseName, input.table),
				indexBody,
				{ contentType: 'text/tab-separated-values' },
			),
		])
		return { dataSha256, indexSha256 }
	}

	// Parts remain the durable body. Manifest digests are the sha256 of the
	// newline-joined per-part digests (one part in memory at a time).
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

function concatUtf8Chunks(chunks: Array<Uint8Array>): Uint8Array {
	let total = 0
	for (const chunk of chunks) total += chunk.byteLength
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
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

function parsePartsPointer(text: string): { partCount: number } | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{')) return null
	try {
		const parsed = JSON.parse(trimmed) as {
			kind?: string
			partCount?: number
		}
		if (
			parsed.kind === 'paced-d1-parts' &&
			Number.isSafeInteger(parsed.partCount) &&
			(parsed.partCount as number) >= 0
		) {
			return { partCount: parsed.partCount as number }
		}
	} catch {
		return null
	}
	return null
}

/**
 * Stream previous-night index parts one file at a time so AUDIT-sized indexes
 * never load into the worker heap for a delta merge-join.
 */
function createStagingPartsIndexReader(input: {
	s3: DrBackupS3Client
	day: string
	databaseName: string
	table: string
	partCount: number
}) {
	let partIndex = 0
	let lines: Array<string> = []
	let lineIndex = 0
	let cur: PacedD1IndexEntry | null = null
	let done = input.partCount === 0

	const refill = async () => {
		while (lineIndex >= lines.length && partIndex < input.partCount) {
			const bytes = await input.s3.getBytes(
				pacedD1StagingIndexPartKey(
					input.day,
					input.databaseName,
					input.table,
					partIndex,
				),
			)
			partIndex += 1
			const text = bytes ? new TextDecoder().decode(bytes) : ''
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
	const key =
		input.prev.indexLocation === 'sealed'
			? pacedD1SealedIndexKey(
					pacedD1RetentionTierForDay(input.prev.day),
					input.source.id,
					input.prev.day,
					input.table,
				)
			: pacedD1StagingIndexKey(input.prev.day, input.source.name, input.table)
	const text = await input.s3.getText(key)
	const body = text?.text ?? ''
	const pointer = parsePartsPointer(body)
	if (pointer && input.prev.indexLocation === 'staging') {
		return createStagingPartsIndexReader({
			s3: input.s3,
			day: input.prev.day,
			databaseName: input.source.name,
			table: input.table,
			partCount: pointer.partCount,
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

/**
 * Oldest in-progress (crashed) night first, then today when any bound source
 * still lacks a manifest. That way nightly catch-up of a stranded older day
 * cannot skip seeding tonight after the older night finishes.
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
		}
	}
	for (const source of input.sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) continue
		if (await sourceNeedsManifest(input.s3, input.today, source.name)) {
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
}): Promise<void> {
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
}): Promise<{
	timeBudgetExhausted: boolean
	tablesCompleted: number
	manifestWritten: boolean
}> {
	let tablesCompleted = 0
	let manifestWritten = false
	if (await sourceHasManifest(input.s3, input.day, input.source.name)) {
		return { timeBudgetExhausted: false, tablesCompleted, manifestWritten }
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
			return { timeBudgetExhausted: true, tablesCompleted, manifestWritten }
		}

		const table = pickNext()
		if (!table) {
			await finalizeSourceNight({
				s3: input.s3,
				source: input.source,
				day: input.day,
				schema,
				meta,
				progress,
			})
			manifestWritten = true
			return { timeBudgetExhausted: false, tablesCompleted, manifestWritten }
		}

		const prevTable = prev?.manifest.tables[table.name]
		const mode = resolvePacedD1TableMode({
			day: input.day,
			tableSchemaHash: table.schemaHash,
			prevSchemaHash: prevTable?.schemaHash,
		})

		const resuming =
			progress.currentTable === table.name && progress.lastRowid !== null
		let partCount = resuming ? progress.partCount : 0
		const writer = createTickTableWriter()
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
			startAfterRowid:
				progress.currentTable === table.name ? progress.lastRowid : null,
			initialPageSize:
				progress.currentTable === table.name ? progress.pageSize : undefined,
			partial:
				progress.currentTable === table.name && progress.lastRowid !== null
					? {
							count: progress.partialCount,
							checksum: progress.partialChecksum,
							upserts: progress.partialUpserts,
							deletes: progress.partialDeletes,
						}
					: undefined,
			opts: {
				budgetMs: budgetLeft,
				...input.walkerOpts,
			},
		})

		meta.queries += result.queries
		meta.rowsRead += result.rowsRead
		meta.d1RowsRead += result.d1RowsRead
		meta.bytesOut += result.bytesOut
		meta.queryMs.push(...result.queryMs)

		if (!writer.isEmpty()) {
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
		}

		if (!result.done) {
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
			await Promise.all([
				persistProgress(input.s3, progress),
				persistNightMeta(input.s3, meta),
			])
			return { timeBudgetExhausted: true, tablesCompleted, manifestWritten }
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

	// Cheap exit when every bound source already finished tonight.
	let allDone = true
	let bindingsMissing = 0
	for (const source of sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) {
			bindingsMissing += 1
			continue
		}
		if (!(await sourceHasManifest(s3, day, source.name))) {
			allDone = false
		}
	}
	if (allDone) {
		return {
			day,
			mode,
			skipped: true,
			reason: 'already-complete',
			timeBudgetExhausted: false,
			sourcesWorked: 0,
			tablesCompleted: 0,
			manifestsWritten: 0,
			bindingsMissing,
		}
	}

	const timeBudgetMs = input.timeBudgetMs ?? d1PacedBackupRunTimeBudgetMs
	const startedAtMs = Date.now()
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
		if (await sourceHasManifest(s3, day, source.name)) continue

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
		})
		sourcesWorked += 1
		tablesCompleted += result.tablesCompleted
		if (result.manifestWritten) manifestsWritten += 1
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
		bindingsMissing,
	}
	console.info('dr_d1_paced_backup_tick', JSON.stringify(tickResult))
	return tickResult
}

export async function runD1PacedBackupWatchdogTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
}): Promise<D1PacedBackupWatchdogResult> {
	const day = formatUtcDay(input.now)
	if (!isD1PacedBackupConfigured(input.env)) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			configuredSources: 0,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			incompleteSources: 0,
			configuredSources: 0,
		}
	}
	const sources = parseD1PacedSources(input.env.DR_D1_PACED_SOURCES)
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	let incomplete = 0
	let configured = 0
	for (const source of sources) {
		if (!resolvePacedD1Binding(input.env, source.binding)) continue
		configured += 1
		if (!(await sourceHasManifest(s3, day, source.name))) {
			incomplete += 1
		}
	}
	const result: D1PacedBackupWatchdogResult = {
		day,
		skipped: incomplete === 0,
		reason: incomplete === 0 ? 'complete' : undefined,
		incompleteSources: incomplete,
		configuredSources: configured,
	}
	console.info('dr_d1_paced_backup_watchdog', JSON.stringify(result))
	if (incomplete > 0) {
		throw new Error(
			`paced D1 shadow backup incomplete for ${day}: ${incomplete}/${configured} sources missing staging manifests`,
		)
	}
	return result
}

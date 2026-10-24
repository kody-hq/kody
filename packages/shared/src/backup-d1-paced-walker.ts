import {
	addPacedD1Checksum,
	comparePacedD1Key,
	encodePacedD1Cell,
	formatPacedD1DeleteLine,
	formatPacedD1IndexLine,
	formatPacedD1UpsertLine,
	hashPacedD1RowLine,
	parsePacedD1IndexLine,
	pacedD1RowLine,
	sha256HexOfText,
	type PacedD1EncodedCell,
	type PacedD1IndexEntry,
} from './backup-d1-paced-encode.ts'
import {
	adaptPacedPageSize,
	pacedBackupGapMs,
	pacedD1BackupDefaultDutyCycle,
	pacedD1BackupDefaultMaxPage,
	pacedD1BackupDefaultMaxPageBytes,
	pacedD1BackupDefaultMinGapMs,
	pacedD1BackupDefaultMinPage,
	pacedD1BackupDefaultTargetPageMs,
	pacedD1BackupSchemaVersion,
	pacedD1BackupSkipTables,
	pacedD1ForcesFullBase,
	pacedD1RetentionTierForDay,
	type PacedD1NightManifest,
	type PacedD1NightStats,
	type PacedD1SchemaExtra,
	type PacedD1TableManifest,
	type PacedD1TableMode,
} from './backup-d1-paced.ts'
import { quoteSqlIdentifier } from './sql-literals.ts'

export type PacedD1QueryMeta = {
	duration?: number
	rows_read?: number
}

export type PacedD1QueryResult = {
	results: Array<Record<string, unknown>>
	meta?: PacedD1QueryMeta
}

export type PacedD1Prepared = {
	bind: (...params: Array<unknown>) => {
		all: () => Promise<PacedD1QueryResult>
		first: <T = Record<string, unknown>>() => Promise<T | null>
	}
}

/** Minimal D1 surface the paced walker needs (binding or test double). */
export type PacedD1Database = {
	prepare: (sql: string) => PacedD1Prepared
}

export type PacedD1DiscoveredTable = {
	name: string
	sql: string
	cols: Array<string>
	declaredPk: Array<string>
	/** Always `['rowid']` — sidesteps nullable / composite declared PKs. */
	pk: Array<'rowid'>
	schemaHash: string
}

export type PacedD1SchemaSnapshot = {
	tables: Array<PacedD1DiscoveredTable>
	extras: Array<PacedD1SchemaExtra>
	schemaHash: string
	sqliteSequence: Array<{ name: string; seq: number }>
}

export type PacedD1IndexReader = {
	peek: () => Promise<PacedD1IndexEntry | null>
	take: () => PacedD1IndexEntry
}

export type PacedD1TableArtifactWriter = {
	appendData: (line: string) => void | Promise<void>
	appendIndex: (line: string) => void | Promise<void>
	finalize: () => Promise<{ dataSha256: string; indexSha256: string }>
}

export type PacedD1WalkerOptions = {
	minPage?: number
	maxPage?: number
	targetMs?: number
	maxBytes?: number
	dutyCycle?: number
	minGapMs?: number
	/** Soft wall budget for one tick; returns when exceeded between pages. */
	budgetMs?: number
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	onPage?: (info: {
		table: string
		ms: number
		rows: number
		page: number
	}) => void | Promise<void>
}

export type PacedD1PrevTable = {
	schemaHash: string
	openIndex: () => PacedD1IndexReader | Promise<PacedD1IndexReader>
}

export type PacedD1TableWalkInput = {
	db: PacedD1Database
	table: PacedD1DiscoveredTable
	mode: PacedD1TableMode
	prev: PacedD1PrevTable | null
	writer: PacedD1TableArtifactWriter
	/** Resume after this rowid (exclusive). */
	startAfterRowid?: number | null
	initialPageSize?: number
	partial?: {
		count: number
		checksum: string
		upserts: number
		deletes: number
	}
	opts?: PacedD1WalkerOptions
}

export type PacedD1TableWalkResult =
	| {
			done: true
			manifest: PacedD1TableManifest
			queries: number
			rowsRead: number
			d1RowsRead: number
			bytesOut: number
			queryMs: Array<number>
	  }
	| {
			done: false
			lastRowid: number
			pageSize: number
			count: number
			checksum: string
			upserts: number
			deletes: number
			queries: number
			rowsRead: number
			d1RowsRead: number
			bytesOut: number
			queryMs: Array<number>
	  }

function defaultSleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function hashPacedD1Text(value: string): Promise<string> {
	return sha256HexOfText(value)
}

export async function discoverPacedD1Schema(
	db: PacedD1Database,
): Promise<PacedD1SchemaSnapshot> {
	const master = await db
		.prepare(
			`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`,
		)
		.bind()
		.all()
	const tables: Array<PacedD1DiscoveredTable> = []
	for (const row of master.results) {
		if (row.type !== 'table') continue
		const name = String(row.name)
		if (pacedD1BackupSkipTables.has(name)) continue
		const info = await db
			.prepare(`SELECT name, pk FROM pragma_table_info(?) ORDER BY cid`)
			.bind(name)
			.all()
		const cols = info.results.map((col) => String(col.name))
		const declaredPk = info.results
			.filter((col) => Number(col.pk) > 0)
			.sort((a, b) => Number(a.pk) - Number(b.pk))
			.map((col) => String(col.name))
		const sql = String(row.sql)
		tables.push({
			name,
			sql,
			cols,
			declaredPk,
			pk: ['rowid'],
			schemaHash: await hashPacedD1Text(sql),
		})
	}
	const extras: Array<PacedD1SchemaExtra> = []
	for (const row of master.results) {
		if (row.type !== 'index' && row.type !== 'trigger') continue
		const table = String(row.tbl_name)
		if (pacedD1BackupSkipTables.has(table)) continue
		extras.push({
			type: row.type,
			name: String(row.name),
			table,
			sql: String(row.sql),
		})
	}
	const seq = await db
		.prepare(`SELECT name, seq FROM sqlite_sequence ORDER BY name`)
		.bind()
		.all()
		.catch(() => ({ results: [] as Array<Record<string, unknown>> }))
	const sqliteSequence = seq.results.map((row) => ({
		name: String(row.name),
		seq: Number(row.seq),
	}))
	const schemaHash = await hashPacedD1Text(
		JSON.stringify(
			master.results
				.filter((row) => !pacedD1BackupSkipTables.has(String(row.tbl_name)))
				.map((row) => row.sql),
		),
	)
	return { tables, extras, schemaHash, sqliteSequence }
}

export function resolvePacedD1TableMode(input: {
	day: string
	tableSchemaHash: string
	prevSchemaHash: string | null | undefined
}): PacedD1TableMode {
	if (pacedD1ForcesFullBase(input.day)) return 'full'
	if (!input.prevSchemaHash || input.prevSchemaHash !== input.tableSchemaHash) {
		return 'full'
	}
	return 'delta'
}

export function createMemoryPacedD1IndexReader(
	tsv: string,
): PacedD1IndexReader {
	const lines = tsv.length === 0 ? [] : tsv.replace(/\n$/, '').split('\n')
	let i = 0
	let cur: PacedD1IndexEntry | null = null
	let done = lines.length === 0
	return {
		async peek() {
			if (cur || done) return cur
			const line = lines[i++]
			if (line === undefined) {
				done = true
				return null
			}
			cur = parsePacedD1IndexLine(line)
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

export function createMemoryPacedD1TableWriter(): PacedD1TableArtifactWriter & {
	data: string
	index: string
} {
	const state = { data: '', index: '' }
	return {
		get data() {
			return state.data
		},
		get index() {
			return state.index
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

/**
 * Walk one table in keyset/rowid pages. Honors `budgetMs` between pages so a
 * crashed or budget-exhausted tick can resume from `lastRowid`.
 */
export async function walkPacedD1Table(
	input: PacedD1TableWalkInput,
): Promise<PacedD1TableWalkResult> {
	const opts = input.opts ?? {}
	const targetMs = opts.targetMs ?? pacedD1BackupDefaultTargetPageMs
	const minPage = opts.minPage ?? pacedD1BackupDefaultMinPage
	const maxPage = opts.maxPage ?? pacedD1BackupDefaultMaxPage
	const maxBytes = opts.maxBytes ?? pacedD1BackupDefaultMaxPageBytes
	const dutyCycle = opts.dutyCycle ?? pacedD1BackupDefaultDutyCycle
	const minGapMs = opts.minGapMs ?? pacedD1BackupDefaultMinGapMs
	const sleep = opts.sleep ?? defaultSleep
	const now = opts.now ?? Date.now
	const started = now()

	const idx =
		input.mode === 'delta' && input.prev
			? await input.prev.openIndex()
			: createMemoryPacedD1IndexReader('')

	let count = input.partial?.count ?? 0
	let checksum = input.partial?.checksum ?? '0000000000000000'
	let upserts = input.partial?.upserts ?? 0
	let deletes = input.partial?.deletes ?? 0
	let lastRowid = input.startAfterRowid ?? null
	let page = input.initialPageSize ?? minPage
	let queries = 0
	let rowsRead = 0
	let d1RowsRead = 0
	let bytesOut = 0
	const queryMs: Array<number> = []

	const selCols = ['__rowid', ...input.table.cols]
	const colList = [
		`rowid AS __rowid`,
		...input.table.cols.map((col) => quoteSqlIdentifier(col)),
	].join(', ')

	const emitDelete = async (k: Array<PacedD1EncodedCell>) => {
		await input.writer.appendData(formatPacedD1DeleteLine(k))
		deletes++
	}

	while (true) {
		if (
			opts.budgetMs !== undefined &&
			now() - started >= opts.budgetMs &&
			lastRowid !== null
		) {
			return {
				done: false,
				lastRowid,
				pageSize: page,
				count,
				checksum,
				upserts,
				deletes,
				queries,
				rowsRead,
				d1RowsRead,
				bytesOut,
				queryMs,
			}
		}

		const sql =
			lastRowid === null
				? `SELECT ${colList} FROM ${quoteSqlIdentifier(input.table.name)} ORDER BY rowid LIMIT ?`
				: `SELECT ${colList} FROM ${quoteSqlIdentifier(input.table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`
		const bound =
			lastRowid === null
				? input.db.prepare(sql).bind(page)
				: input.db.prepare(sql).bind(lastRowid, page)
		const res = await bound.all()
		queries++
		const durationMs = res.meta?.duration ?? 0
		d1RowsRead += res.meta?.rows_read ?? 0
		queryMs.push(durationMs)
		const rows = res.results
		rowsRead += rows.length
		let pageBytes = 0

		for (const obj of rows) {
			const vals = selCols.map((col) => encodePacedD1Cell(obj[col]))
			const k: Array<PacedD1EncodedCell> = [vals[0]!]
			const line = pacedD1RowLine(vals)
			pageBytes += line.length
			const h = await hashPacedD1RowLine(line)
			count++
			checksum = addPacedD1Checksum(checksum, h)
			await input.writer.appendIndex(formatPacedD1IndexLine({ h, k }))

			let changed = true
			while (true) {
				const prev = await idx.peek()
				if (!prev) break
				const cmp = comparePacedD1Key(prev.k, k)
				if (cmp < 0) {
					await emitDelete(idx.take().k)
					continue
				}
				if (cmp === 0) {
					changed = idx.take().h !== h
				}
				break
			}
			if (input.mode === 'full' || changed) {
				await input.writer.appendData(
					formatPacedD1UpsertLine({ h, k, row: line }),
				)
				upserts++
				bytesOut += line.length
			}
			lastRowid = Number(vals[0])
		}

		await opts.onPage?.({
			table: input.table.name,
			ms: durationMs,
			rows: rows.length,
			page,
		})

		if (rows.length < page) {
			while (await idx.peek()) {
				await emitDelete(idx.take().k)
			}
			const hashes = await input.writer.finalize()
			return {
				done: true,
				manifest: {
					mode: input.mode,
					schemaHash: input.table.schemaHash,
					sql: input.table.sql,
					cols: selCols,
					pk: ['rowid'],
					declaredPk: input.table.declaredPk,
					count,
					checksum,
					upserts,
					deletes,
					dataSha256: hashes.dataSha256,
					indexSha256: hashes.indexSha256,
				},
				queries,
				rowsRead,
				d1RowsRead,
				bytesOut,
				queryMs,
			}
		}

		page = adaptPacedPageSize({
			page,
			durationMs,
			pageBytes,
			targetMs,
			minPage,
			maxPage,
			maxBytes,
		})
		await sleep(pacedBackupGapMs({ durationMs, dutyCycle, minGapMs }))
	}
}

export function summarizePacedQueryMs(
	queryMs: Array<number>,
	wallMs: number,
	counters: {
		queries: number
		rowsRead: number
		d1RowsRead: number
		bytesOut: number
	},
): PacedD1NightStats {
	const sorted = [...queryMs].sort((a, b) => a - b)
	const at = (p: number) =>
		sorted.length === 0
			? 0
			: sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
	const sum = sorted.reduce((acc, ms) => acc + ms, 0)
	return {
		wallMs,
		queries: counters.queries,
		rowsRead: counters.rowsRead,
		d1RowsRead: counters.d1RowsRead,
		bytesOut: counters.bytesOut,
		queryMs: {
			p50: at(0.5),
			p95: at(0.95),
			p99: at(0.99),
			max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
			sum,
		},
		dbTimeShare: wallMs > 0 ? sum / wallMs : 0,
	}
}

export async function buildPacedD1NightManifest(input: {
	databaseName: string
	databaseId: string
	day: string
	startedAt: string
	finishedAt: string
	prevDay: string | null
	prevManifestSha256: string | null
	schema: PacedD1SchemaSnapshot
	schemaStableDuringWalk: boolean
	timeTravelBookmark: string | null
	tables: Record<string, PacedD1TableManifest>
	stats: PacedD1NightStats
	shadow: boolean
}): Promise<{ manifest: PacedD1NightManifest; sha256: string }> {
	const manifest: PacedD1NightManifest = {
		schemaVersion: pacedD1BackupSchemaVersion,
		databaseName: input.databaseName,
		databaseId: input.databaseId,
		day: input.day,
		retentionTier: pacedD1RetentionTierForDay(input.day),
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		prevDay: input.prevDay,
		prevManifestSha256: input.prevManifestSha256,
		schemaHash: input.schema.schemaHash,
		schemaStableDuringWalk: input.schemaStableDuringWalk,
		timeTravelBookmark: input.timeTravelBookmark,
		extras: input.schema.extras,
		sqliteSequence: input.schema.sqliteSequence,
		tables: input.tables,
		stats: input.stats,
		shadow: input.shadow,
	}
	const raw = `${JSON.stringify(manifest, null, 1)}\n`
	return { manifest, sha256: await sha256HexOfText(raw) }
}

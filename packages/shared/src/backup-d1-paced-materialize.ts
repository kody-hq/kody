/**
 * Materialize a sealed paced D1 chain (full base plus deltas) into SQL for an
 * empty target database, one bounded unit at a time. Memory per unit is one
 * base part plus the rows the deltas touched since that base.
 */
import {
	addPacedD1Checksum,
	encodePacedD1Cell,
	hashPacedD1RowLine,
	pacedD1RowLine,
	parsePacedD1DataLine,
} from './backup-d1-paced-encode.ts'
import {
	readPacedD1TablePartCount,
	streamSealedPacedD1TableLines,
	type PacedD1ObjectReader,
	type PacedD1SourceRef,
	type SealedPacedD1Night,
} from './backup-d1-paced-read.ts'
import {
	emitUpsertStatements,
	pacedD1RestoreScratchTable,
	type PacedD1RestoreSqlStats,
} from './backup-d1-paced-restore.ts'
import { quoteSqlIdentifier, quoteSqlString } from './sql-literals.ts'

export type PacedD1RestoreUnit =
	| { kind: 'schema' }
	| { kind: 'base'; table: string; partStart: number; partEnd: number }
	| { kind: 'delta'; table: string }
	| { kind: 'finish' }

export type PacedD1RestoreUnitResult = {
	table: string | null
	rows: number
	statements: number
}

export type PacedD1TargetScan = {
	count: number
	checksum: string
	lastRowid: number | null
	done: boolean
}

/** Next page of a restored table, selected the way the paced walker reads. */
export function pacedD1TargetPageSql(input: {
	table: string
	cols: Array<string>
	afterRowid: number | null
	limit: number
}): string {
	const colList = input.cols
		.map((col) =>
			col === '__rowid' ? 'rowid AS __rowid' : quoteSqlIdentifier(col),
		)
		.join(', ')
	const where =
		input.afterRowid === null ? '' : ` WHERE rowid > ${input.afterRowid}`
	return `SELECT ${colList} FROM ${quoteSqlIdentifier(input.table)}${where} ORDER BY rowid LIMIT ${input.limit}`
}

/**
 * Fold one page of target rows into a scan, hashing each row with the backup
 * encoding so the result compares directly with the sealed manifest.
 */
export async function scanPacedD1TargetPage(input: {
	cols: Array<string>
	rows: Array<Record<string, unknown>>
	limit: number
	scan: PacedD1TargetScan
}): Promise<PacedD1TargetScan> {
	let { count, checksum, lastRowid } = input.scan
	for (const row of input.rows) {
		const vals = input.cols.map((col) => encodePacedD1Cell(row[col]))
		checksum = addPacedD1Checksum(
			checksum,
			await hashPacedD1RowLine(pacedD1RowLine(vals)),
		)
		count += 1
		lastRowid = Number(vals[0])
	}
	return { count, checksum, lastRowid, done: input.rows.length < input.limit }
}

function tipOf(chain: Array<SealedPacedD1Night>) {
	const tip = chain[chain.length - 1]
	if (!tip) throw new Error('paced D1 restore needs a sealed night')
	return tip.manifest
}

/**
 * Where a table's rows come from: the last `full` night in the trailing run of
 * nights that include it (the base), and the delta nights after it.
 */
function tableSegment(chain: Array<SealedPacedD1Night>, table: string) {
	let segmentStart = 0
	chain.forEach((night, index) => {
		if (!night.manifest.tables[table]) segmentStart = index + 1
	})
	let baseIndex = -1
	for (let index = segmentStart; index < chain.length; index += 1) {
		if (chain[index]!.manifest.tables[table]!.mode === 'full') {
			baseIndex = index
		}
	}
	return {
		baseIndex,
		deltaStart: baseIndex >= 0 ? baseIndex + 1 : segmentStart,
	}
}

export async function planPacedD1Restore(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	chain: Array<SealedPacedD1Night>
	partsPerUnit: number
}): Promise<Array<PacedD1RestoreUnit>> {
	const units: Array<PacedD1RestoreUnit> = [{ kind: 'schema' }]
	for (const table of Object.keys(tipOf(input.chain).tables)) {
		const { baseIndex } = tableSegment(input.chain, table)
		if (baseIndex >= 0) {
			const partCount = await readPacedD1TablePartCount({
				reader: input.reader,
				source: input.source,
				day: input.chain[baseIndex]!.manifest.day,
				table,
			})
			for (let start = 0; start < partCount; start += input.partsPerUnit) {
				units.push({
					kind: 'base',
					table,
					partStart: start,
					partEnd: Math.min(start + input.partsPerUnit, partCount),
				})
			}
		}
		units.push({ kind: 'delta', table })
	}
	units.push({ kind: 'finish' })
	return units
}

type TouchedRow = { row: string } | null

/** rowid -> latest delta row (null when a later delta deleted it). */
async function readTouchedRows(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	chain: Array<SealedPacedD1Night>
	table: string
}): Promise<Map<number, TouchedRow>> {
	const { deltaStart } = tableSegment(input.chain, input.table)
	const touched = new Map<number, TouchedRow>()
	for (let index = deltaStart; index < input.chain.length; index += 1) {
		const night = input.chain[index]!.manifest
		await streamSealedPacedD1TableLines({
			reader: input.reader,
			source: input.source,
			day: night.day,
			table: input.table,
			tableManifest: night.tables[input.table]!,
			onLine: (line) => {
				const parsed = parsePacedD1DataLine(line)
				const rowid = Number(parsed.k[0])
				touched.set(rowid, parsed.kind === 'D' ? null : { row: parsed.row })
			},
		})
	}
	return touched
}

/**
 * Emit one unit's SQL in chunks of about `maxChunkBytes`, awaiting
 * `importChunk` for each. Rows use INSERT OR REPLACE and the schema drops
 * before it creates, so a retried unit converges on the same state.
 */
export async function runPacedD1RestoreUnit(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	chain: Array<SealedPacedD1Night>
	unit: PacedD1RestoreUnit
	maxChunkBytes: number
	importChunk: (sql: string) => Promise<void>
}): Promise<PacedD1RestoreUnitResult> {
	const tip = tipOf(input.chain)
	const encoder = new TextEncoder()
	let chunk: Array<string> = []
	let chunkBytes = 0
	const stats: PacedD1RestoreSqlStats = {
		statements: 0,
		splitRows: 0,
		maxStmtBytes: 0,
	}
	const pending: Array<string> = []
	const push = (statement: string) => {
		stats.statements += 1
		chunk.push(statement)
		chunkBytes += encoder.encode(statement).byteLength + 1
		if (chunkBytes >= input.maxChunkBytes) {
			pending.push(`${chunk.join('\n')}\n`)
			chunk = []
			chunkBytes = 0
		}
	}
	const drain = async () => {
		while (pending.length > 0) await input.importChunk(pending.shift()!)
	}
	const flush = async () => {
		if (chunk.length > 0) pending.push(`${chunk.join('\n')}\n`)
		chunk = []
		chunkBytes = 0
		await drain()
	}

	const unit = input.unit
	if (unit.kind === 'schema') {
		for (const [table, manifest] of Object.entries(tip.tables)) {
			push(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(table)};`)
			push(`${manifest.sql};`)
		}
		await flush()
		return { table: null, rows: 0, statements: stats.statements }
	}
	if (unit.kind === 'finish') {
		push(
			`DROP TABLE IF EXISTS ${quoteSqlIdentifier(pacedD1RestoreScratchTable)};`,
		)
		if (tip.sqliteSequence.length > 0) {
			push('DELETE FROM sqlite_sequence;')
			for (const row of tip.sqliteSequence) {
				push(
					`INSERT INTO sqlite_sequence(name, seq) VALUES (${quoteSqlString(row.name)}, ${row.seq});`,
				)
			}
		}
		for (const extra of [...tip.extras].sort((a, b) => {
			if (a.type === 'index' && b.type !== 'index') return -1
			if (a.type !== 'index' && b.type === 'index') return 1
			return a.name.localeCompare(b.name)
		})) {
			push(
				`DROP ${extra.type.toUpperCase()} IF EXISTS ${quoteSqlIdentifier(extra.name)};`,
			)
			push(`${extra.sql};`)
		}
		await flush()
		return { table: null, rows: 0, statements: stats.statements }
	}

	const tableManifest = tip.tables[unit.table]
	if (!tableManifest) {
		throw new Error(`paced D1 restore table ${unit.table} is not in the tip`)
	}
	const touched = await readTouchedRows({
		reader: input.reader,
		source: input.source,
		chain: input.chain,
		table: unit.table,
	})
	let rows = 0
	const emit = (row: string) => {
		emitUpsertStatements({
			table: unit.table,
			cols: tableManifest.cols,
			vals: JSON.parse(row) as Parameters<
				typeof emitUpsertStatements
			>[0]['vals'],
			push,
			stats,
		})
		rows += 1
	}

	if (unit.kind === 'base') {
		const { baseIndex } = tableSegment(input.chain, unit.table)
		const base = input.chain[baseIndex]!.manifest
		await streamSealedPacedD1TableLines({
			reader: input.reader,
			source: input.source,
			day: base.day,
			table: unit.table,
			tableManifest: base.tables[unit.table]!,
			parts: { start: unit.partStart, end: unit.partEnd },
			onLine: (line) => {
				const parsed = parsePacedD1DataLine(line)
				if (parsed.kind === 'D') return
				if (touched.has(Number(parsed.k[0]))) return
				emit(parsed.row)
			},
			onPart: drain,
		})
	} else {
		for (const entry of touched.values()) {
			if (entry !== null) emit(entry.row)
		}
	}
	await flush()
	return {
		table: unit.table,
		rows,
		statements: stats.statements,
	}
}

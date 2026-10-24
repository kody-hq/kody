import { base64ToBytes } from './base64.ts'
import {
	hashPacedD1RowLine,
	parsePacedD1DataLine,
	type PacedD1EncodedCell,
} from './backup-d1-paced-encode.ts'
import {
	pacedD1BackupMaxSqlStatementBytes,
	pacedD1BackupRestoreTextChunkChars,
	type PacedD1NightManifest,
	type PacedD1TableManifest,
} from './backup-d1-paced.ts'
import { quoteSqlIdentifier, quoteSqlString } from './sql-literals.ts'
import { sha256Hex } from './sha256.ts'

export type PacedD1RestoredRow = {
	h: string
	row: string
}

export type PacedD1RestoreTableState = Map<number, PacedD1RestoredRow>

export type PacedD1RestoreChainState = {
	tables: Map<string, PacedD1RestoreTableState>
	schema: Map<string, PacedD1TableManifest>
	lastManifest: PacedD1NightManifest | null
}

export type PacedD1NightArtifacts = {
	manifest: PacedD1NightManifest
	manifestRaw: string
	dataByTable: Record<string, string>
}

export type PacedD1RestoreSqlStats = {
	statements: number
	splitRows: number
	maxStmtBytes: number
}

function sqlLiteral(value: PacedD1EncodedCell): string {
	if (value === null) return 'NULL'
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('paced restore refuses non-finite number')
		}
		return String(value)
	}
	if (typeof value === 'object' && value !== null && '$b' in value) {
		const bytes = base64ToBytes(value.$b)
		let hex = ''
		for (const byte of bytes) {
			hex += byte.toString(16).padStart(2, '0')
		}
		return `X'${hex}'`
	}
	return quoteSqlString(String(value))
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

export function createEmptyPacedD1RestoreState(): PacedD1RestoreChainState {
	return {
		tables: new Map(),
		schema: new Map(),
		lastManifest: null,
	}
}

/**
 * Apply a sealed night onto an in-memory row map. When `prevManifestRaw` is
 * passed, the chain link (`prevManifestSha256`) is checked against it.
 */
export async function applyPacedD1NightToState(input: {
	state: PacedD1RestoreChainState
	night: PacedD1NightArtifacts
	prevManifestRaw?: string | null
	verify?: boolean
}): Promise<void> {
	const verify = input.verify ?? true
	const { state, night } = input

	if (verify) {
		const expectedPrev =
			input.prevManifestRaw === undefined
				? night.manifest.prevManifestSha256
				: input.prevManifestRaw === null
					? null
					: await sha256Hex(input.prevManifestRaw)
		if (
			input.prevManifestRaw !== undefined &&
			night.manifest.prevManifestSha256 !== expectedPrev
		) {
			throw new Error('CHAIN BROKEN: prevManifestSha256 mismatch')
		}
	}

	for (const [table, tableManifest] of Object.entries(night.manifest.tables)) {
		const data = night.dataByTable[table]
		if (data === undefined) {
			throw new Error(`paced restore missing data artifact for ${table}`)
		}
		if (verify) {
			const dataSha = await sha256Hex(data)
			if (dataSha !== tableManifest.dataSha256) {
				throw new Error(
					`CORRUPT artifact ${table}: sha256 mismatch, refusing to restore`,
				)
			}
		}
		if (tableManifest.mode === 'full' || !state.tables.has(table)) {
			state.tables.set(table, new Map())
		}
		const rows = state.tables.get(table)!
		const lines = data.length === 0 ? [] : data.replace(/\n$/, '').split('\n')
		for (const rawLine of lines) {
			const parsed = parsePacedD1DataLine(rawLine)
			if (parsed.kind === 'D') {
				rows.delete(Number(parsed.k[0]))
				continue
			}
			if (verify && parsed.h !== '-') {
				const expected = await hashPacedD1RowLine(parsed.row)
				if (expected !== parsed.h) {
					throw new Error(`CORRUPT row in ${table}`)
				}
			}
			rows.set(Number(parsed.k[0]), { h: parsed.h, row: parsed.row })
		}
		state.schema.set(table, tableManifest)
	}

	for (const table of state.tables.keys()) {
		if (!(table in night.manifest.tables)) {
			state.tables.delete(table)
			state.schema.delete(table)
		}
	}

	if (verify) {
		for (const [table, tableManifest] of Object.entries(
			night.manifest.tables,
		)) {
			const rows = state.tables.get(table) ?? new Map()
			let sum = 0n
			for (const { h } of rows.values()) {
				sum = (sum + BigInt(`0x${h.slice(0, 16)}`)) & 0xffffffffffffffffn
			}
			const checksum = sum.toString(16).padStart(16, '0')
			if (
				rows.size !== tableManifest.count ||
				checksum !== tableManifest.checksum
			) {
				throw new Error(
					`VERIFY FAILED on ${table}: count ${rows.size} vs ${tableManifest.count}, checksum ${checksum} vs ${tableManifest.checksum}`,
				)
			}
		}
	}

	state.lastManifest = night.manifest
}

function buildInsertSql(
	table: string,
	cols: Array<string>,
	vals: Array<PacedD1EncodedCell>,
): string {
	const names = cols.map((col, index) =>
		index === 0 && col === '__rowid' ? 'rowid' : quoteSqlIdentifier(col),
	)
	const lits = vals.map((value) => sqlLiteral(value))
	return `INSERT OR REPLACE INTO ${quoteSqlIdentifier(table)} (${names.join(', ')}) VALUES (${lits.join(', ')});`
}

function emitUpsertStatements(input: {
	table: string
	cols: Array<string>
	vals: Array<PacedD1EncodedCell>
	push: (statement: string) => void
	stats: PacedD1RestoreSqlStats
}): void {
	const sql = buildInsertSql(input.table, input.cols, input.vals)
	if (utf8Bytes(sql) <= pacedD1BackupMaxSqlStatementBytes) {
		input.push(sql)
		return
	}

	input.stats.splitRows++
	const pending: Array<number> = []
	const reduced = [...input.vals]
	const ranked = [...input.vals.keys()]
		.slice(1)
		.sort(
			(a, b) =>
				utf8Bytes(sqlLiteral(input.vals[b]!)) -
				utf8Bytes(sqlLiteral(input.vals[a]!)),
		)
	for (const index of ranked) {
		if (
			utf8Bytes(buildInsertSql(input.table, input.cols, reduced)) <=
			pacedD1BackupMaxSqlStatementBytes - 2000
		) {
			break
		}
		if (typeof input.vals[index] === 'string') {
			pending.push(index)
			reduced[index] = ''
		}
	}
	input.push(buildInsertSql(input.table, input.cols, reduced))
	const rowid = Number(input.vals[0])
	for (const index of pending) {
		const text = String(input.vals[index])
		const col =
			input.cols[index] === '__rowid'
				? 'rowid'
				: quoteSqlIdentifier(input.cols[index]!)
		let pos = 0
		while (pos < text.length) {
			const chunk = text.slice(pos, pos + pacedD1BackupRestoreTextChunkChars)
			pos += chunk.length
			input.push(
				`UPDATE ${quoteSqlIdentifier(input.table)} SET ${col} = ${col} || ${quoteSqlString(chunk)} WHERE rowid = ${rowid};`,
			)
		}
	}
}

/**
 * Emit one consolidated, D1-import-sized SQL stream from a merged restore state.
 */
export function buildPacedD1RestoreSql(state: PacedD1RestoreChainState): {
	sql: string
	stats: PacedD1RestoreSqlStats
} {
	const statements: Array<string> = ['PRAGMA foreign_keys=OFF;']
	const stats: PacedD1RestoreSqlStats = {
		statements: 0,
		splitRows: 0,
		maxStmtBytes: 0,
	}
	const push = (statement: string) => {
		const bytes = utf8Bytes(statement)
		if (bytes > pacedD1BackupMaxSqlStatementBytes) {
			throw new Error(`statement too long: ${bytes}`)
		}
		stats.statements++
		stats.maxStmtBytes = Math.max(stats.maxStmtBytes, bytes)
		statements.push(statement)
	}

	const schema = state.lastManifest
	if (!schema) {
		return { sql: `${statements.join('\n')}\n`, stats }
	}

	for (const [table, tableManifest] of Object.entries(schema.tables)) {
		push(`${tableManifest.sql};`)
		const rows = state.tables.get(table) ?? new Map()
		for (const rowid of [...rows.keys()].sort((a, b) => a - b)) {
			const entry = rows.get(rowid)!
			const vals = JSON.parse(entry.row) as Array<PacedD1EncodedCell>
			emitUpsertStatements({
				table,
				cols: tableManifest.cols,
				vals,
				push,
				stats,
			})
		}
	}

	if (schema.sqliteSequence.length > 0) {
		push('DELETE FROM sqlite_sequence;')
		for (const row of schema.sqliteSequence) {
			push(
				`INSERT INTO sqlite_sequence(name, seq) VALUES (${quoteSqlString(row.name)}, ${row.seq});`,
			)
		}
	}
	for (const extra of [...schema.extras].sort((a, b) => {
		if (a.type === 'index' && b.type !== 'index') return -1
		if (a.type !== 'index' && b.type === 'index') return 1
		return a.name.localeCompare(b.name)
	})) {
		push(`${extra.sql};`)
	}

	return { sql: `${statements.join('\n')}\n`, stats }
}

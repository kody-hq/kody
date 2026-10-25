import {
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	parsePacedD1NightManifest,
	type PacedD1NightManifest,
	type PacedD1TableManifest,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	sha256HexOfBytes,
	sha256HexOfText,
} from '@kody-internal/shared/backup-d1-paced-encode.ts'
import {
	applyPacedD1TableDataTextToState,
	createEmptyPacedD1RestoreState,
	pacedD1RestoreTableChecksum,
} from '@kody-internal/shared/backup-d1-paced-restore.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { isD1PacedRestoreDrillConfigured } from '#worker/dr/d1-paced-backup-schedule.ts'
import {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'
import { parsePacedD1PartsPointer } from '#worker/dr/d1-paced-backup-seal.ts'

export type D1PacedRestoreDrillTableResult = {
	table: string
	manifestCount: number
	restoredCount: number
	liveCount: number | null
	ok: boolean
	error?: string
}

export type D1PacedRestoreDrillSourceResult = {
	databaseName: string
	databaseId: string
	day: string
	manifestKey: string
	nightsApplied: number
	tables: Array<D1PacedRestoreDrillTableResult>
	restoreStatements: number
	ok: boolean
	error?: string
}

export type D1PacedRestoreDrillResult = {
	day: string
	skipped: boolean
	reason?: string
	sourcesChecked: number
	sourcesOk: number
	sources: Array<D1PacedRestoreDrillSourceResult>
	/** S3 key of the durable report when written. */
	reportKey?: string
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function utcDayMinus(day: string, daysBack: number) {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return date.toISOString().slice(0, 10)
}

/** Durable drill report under staging (mutable) for operator inspection. */
export function pacedD1RestoreDrillReportKey(day: string) {
	return `staging/${day}/d1-paced/restore-drill-report.json`
}

async function loadSealedManifest(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
}): Promise<{
	manifest: PacedD1NightManifest
	raw: string
	key: string
} | null> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const key = pacedD1SealedManifestKey(tier, input.source.id, input.day)
	const raw = await input.s3.getText(key)
	if (!raw) return null
	return {
		manifest: parsePacedD1NightManifest(JSON.parse(raw.text)),
		raw: raw.text,
		key,
	}
}

/**
 * Walk sealed nights backward until every table is covered by a `full` base
 * (or the chain ends). Returns oldest-first for apply.
 */
async function loadSealedNightChain(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
}): Promise<
	Array<{ manifest: PacedD1NightManifest; raw: string; key: string }>
> {
	const chain: Array<{
		manifest: PacedD1NightManifest
		raw: string
		key: string
	}> = []
	let cursor: string | null = input.day
	const seen = new Set<string>()
	while (cursor) {
		if (seen.has(cursor)) {
			throw new Error(`paced D1 restore drill cycle at ${cursor}`)
		}
		seen.add(cursor)
		const night = await loadSealedManifest({
			s3: input.s3,
			source: input.source,
			day: cursor,
		})
		if (!night) {
			if (chain.length === 0) return []
			throw new Error(
				`paced D1 restore drill broken chain: missing sealed night ${cursor} for ${input.source.name}`,
			)
		}
		chain.push(night)
		const allFull = Object.values(night.manifest.tables).every(
			(table) => table.mode === 'full',
		)
		if (allFull || night.manifest.prevDay === null) break
		cursor = night.manifest.prevDay
	}
	return chain.reverse()
}

async function countLiveTable(
	db: D1Database,
	table: string,
	bookmark: string | null,
): Promise<number | null> {
	const sql = `SELECT COUNT(*) AS n FROM ${quoteSqlIdentifier(table)}`
	try {
		if (bookmark && typeof db.withSession === 'function') {
			const session = db.withSession(bookmark)
			const row = await session.prepare(sql).first<{ n: number }>()
			return row ? Number(row.n) : null
		}
		const row = await db.prepare(sql).first<{ n: number }>()
		return row ? Number(row.n) : null
	} catch {
		return null
	}
}

/**
 * Stream sealed table data into restore state one part (or monolithic body)
 * at a time. Never concatenates all parts into one string. Skips full-body
 * sha when parts are used (chain digests verified per part); row bodies are
 * not retained.
 */
async function applySealedTableStreaming(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	table: string
	tableManifest: PacedD1TableManifest
	state: ReturnType<typeof createEmptyPacedD1RestoreState>
}): Promise<{ usedParts: boolean }> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const dataKey = pacedD1SealedDataKey(
		tier,
		input.source.id,
		input.day,
		input.table,
	)
	const indexKey = pacedD1SealedIndexKey(
		tier,
		input.source.id,
		input.day,
		input.table,
	)
	const dataObj = await input.s3.getText(dataKey)
	if (!dataObj) {
		throw new Error(`paced D1 missing sealed data at ${dataKey}`)
	}
	// Index is verified for presence + digests only; drill does not need index
	// lines in restore state.
	const indexObj = await input.s3.getText(indexKey)
	if (!indexObj) {
		throw new Error(`paced D1 missing sealed index at ${indexKey}`)
	}

	const dataPointer = parsePacedD1PartsPointer(dataObj.text)
	const indexPointer = parsePacedD1PartsPointer(indexObj.text)

	if (!dataPointer) {
		await applyPacedD1TableDataTextToState({
			state: input.state,
			table: input.table,
			tableManifest: input.tableManifest,
			data: dataObj.text,
			verify: true,
			retainRowBodies: false,
		})
		return { usedParts: false }
	}

	if (!indexPointer || indexPointer.partCount !== dataPointer.partCount) {
		throw new Error(
			`paced D1 parts pointer mismatch for ${input.source.name}.${input.table}`,
		)
	}
	if (dataPointer.dataSha256 !== input.tableManifest.dataSha256) {
		throw new Error(
			`paced D1 parts data digest disagrees with manifest for ${input.source.name}.${input.table}`,
		)
	}

	const digests: Array<string> = []
	let residual = ''
	if (
		input.tableManifest.mode === 'full' ||
		!input.state.tables.has(input.table)
	) {
		input.state.tables.set(input.table, new Map())
	}
	input.state.schema.set(input.table, input.tableManifest)

	for (let partIndex = 0; partIndex < dataPointer.partCount; partIndex += 1) {
		const partKey = pacedD1SealedDataPartKey(
			tier,
			input.source.id,
			input.day,
			input.table,
			partIndex,
		)
		const indexPartKey = pacedD1SealedIndexPartKey(
			tier,
			input.source.id,
			input.day,
			input.table,
			partIndex,
		)
		// Sequential: one part body in memory (matches seal/finalize OOM fix).
		const dataBytes = await input.s3.getBytes(partKey)
		if (!dataBytes) {
			throw new Error(`paced D1 missing data part ${partIndex} at ${partKey}`)
		}
		const dataDigest = await sha256HexOfBytes(dataBytes)
		const indexBytes = await input.s3.getBytes(indexPartKey)
		if (!indexBytes) {
			throw new Error(
				`paced D1 missing index part ${partIndex} at ${indexPartKey}`,
			)
		}
		const indexDigest = await sha256HexOfBytes(indexBytes)
		if (dataDigest !== dataPointer.dataPartDigests[partIndex]) {
			throw new Error(
				`paced D1 data part ${partIndex} digest mismatch for ${input.source.name}.${input.table}`,
			)
		}
		if (indexDigest !== indexPointer.indexPartDigests[partIndex]) {
			throw new Error(
				`paced D1 index part ${partIndex} digest mismatch for ${input.source.name}.${input.table}`,
			)
		}
		digests.push(dataDigest)
		// Drop index bytes immediately after digest check.
		void indexBytes

		const chunk = new TextDecoder().decode(dataBytes)
		const combined = residual + chunk
		const lastNl = combined.lastIndexOf('\n')
		if (lastNl < 0) {
			residual = combined
			continue
		}
		const complete = combined.slice(0, lastNl + 1)
		residual = combined.slice(lastNl + 1)
		await applyPacedD1TableDataTextToState({
			state: input.state,
			table: input.table,
			tableManifest: {
				...input.tableManifest,
				// Subsequent parts are deltas onto the in-memory map.
				mode: partIndex === 0 ? input.tableManifest.mode : 'delta',
			},
			data: complete,
			// Parts chain digests replace monolithic body sha.
			verify: false,
			retainRowBodies: false,
		})
	}

	if (residual.length > 0) {
		await applyPacedD1TableDataTextToState({
			state: input.state,
			table: input.table,
			tableManifest: { ...input.tableManifest, mode: 'delta' },
			data: residual.endsWith('\n') ? residual : `${residual}\n`,
			verify: false,
			retainRowBodies: false,
		})
	}

	const chainSha = await sha256HexOfText(`${digests.join('\n')}\n`)
	if (chainSha !== input.tableManifest.dataSha256) {
		throw new Error(
			`paced D1 data parts chain digest mismatch for ${input.source.name}.${input.table}`,
		)
	}
	return { usedParts: true }
}

async function drillOneTable(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	db: D1Database
	chain: Array<{ manifest: PacedD1NightManifest; raw: string; key: string }>
	table: string
}): Promise<D1PacedRestoreDrillTableResult> {
	const tip = input.chain[input.chain.length - 1]!
	const tipManifest = tip.manifest.tables[input.table]
	if (!tipManifest) {
		return {
			table: input.table,
			manifestCount: 0,
			restoredCount: 0,
			liveCount: null,
			ok: false,
			error: 'missing-from-tip-manifest',
		}
	}

	const state = createEmptyPacedD1RestoreState()
	try {
		let prevRaw: string | undefined
		for (const night of input.chain) {
			// Parts nights skip monolithic body sha; still verify the chain link
			// so a parts night cannot skip prevManifestSha256. First night may
			// cite an older prev — only check once we have the prior raw.
			if (prevRaw !== undefined) {
				const expectedPrev = await sha256Hex(prevRaw)
				if (night.manifest.prevManifestSha256 !== expectedPrev) {
					throw new Error('CHAIN BROKEN: prevManifestSha256 mismatch')
				}
			}
			const tableManifest = night.manifest.tables[input.table]
			if (!tableManifest) {
				// Night omitted this table — drop it from state (same as full-night apply).
				state.tables.delete(input.table)
				state.schema.delete(input.table)
				prevRaw = night.raw
				continue
			}
			await applySealedTableStreaming({
				s3: input.s3,
				source: input.source,
				day: night.manifest.day,
				table: input.table,
				tableManifest,
				state,
			})
			prevRaw = night.raw
		}

		const rows = state.tables.get(input.table) ?? new Map()
		const checksum = pacedD1RestoreTableChecksum(rows)
		const checksumOk =
			rows.size === tipManifest.count && checksum === tipManifest.checksum
		const liveCount = await countLiveTable(
			input.db,
			input.table,
			tip.manifest.timeTravelBookmark,
		)
		const tableOk = checksumOk
		return {
			table: input.table,
			manifestCount: tipManifest.count,
			restoredCount: rows.size,
			liveCount,
			ok: tableOk,
			error: tableOk ? undefined : 'restore-checksum-mismatch',
		}
	} catch (error) {
		return {
			table: input.table,
			manifestCount: tipManifest.count,
			restoredCount: 0,
			liveCount: null,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

async function drillOneSource(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	db: D1Database
	day: string
}): Promise<D1PacedRestoreDrillSourceResult> {
	const chain = await loadSealedNightChain({
		s3: input.s3,
		source: input.source,
		day: input.day,
	})
	if (chain.length === 0) {
		return {
			databaseName: input.source.name,
			databaseId: input.source.id,
			day: input.day,
			manifestKey: pacedD1SealedManifestKey(
				pacedD1RetentionTierForDay(input.day),
				input.source.id,
				input.day,
			),
			nightsApplied: 0,
			tables: [],
			restoreStatements: 0,
			ok: false,
			error: 'sealed-manifest-missing',
		}
	}

	const tip = chain[chain.length - 1]!
	const tables: Array<D1PacedRestoreDrillTableResult> = []
	let ok = true
	for (const table of Object.keys(tip.manifest.tables)) {
		const result = await drillOneTable({
			s3: input.s3,
			source: input.source,
			db: input.db,
			chain,
			table,
		})
		tables.push(result)
		if (!result.ok) ok = false
	}

	return {
		databaseName: input.source.name,
		databaseId: input.source.id,
		day: tip.manifest.day,
		manifestKey: tip.key,
		nightsApplied: chain.length,
		tables,
		// Statement emission skipped in streaming drill (row bodies not retained).
		restoreStatements: 0,
		ok,
		error: ok ? undefined : 'table-mismatch',
	}
}

async function writeDrillReport(input: {
	s3: DrBackupS3Client
	day: string
	result: D1PacedRestoreDrillResult
	finishedAt: string
}): Promise<string> {
	const key = pacedD1RestoreDrillReportKey(input.day)
	const body = `${JSON.stringify(
		{
			schemaVersion: 1,
			kind: 'paced-d1-restore-drill-report',
			finishedAt: input.finishedAt,
			...input.result,
		},
		null,
		2,
	)}\n`
	await input.s3.put(key, body, { contentType: 'application/json' })
	return key
}

/**
 * Weekly drill: for each configured source, walk the sealed night chain one
 * table at a time (streaming parts, hash-only row state), verify tip checksums,
 * and write a durable S3 report. Throws on mismatch so the scheduled lane
 * surfaces in Sentry.
 */
export async function runD1PacedRestoreDrillTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
	/** Override which UTC day to drill (defaults to yesterday). */
	day?: string
}): Promise<D1PacedRestoreDrillResult> {
	const today = formatUtcDay(input.now)
	const day = input.day ?? utcDayMinus(today, 1)
	const empty = (reason: string): D1PacedRestoreDrillResult => ({
		day,
		skipped: true,
		reason,
		sourcesChecked: 0,
		sourcesOk: 0,
		sources: [],
	})

	if (!isD1PacedRestoreDrillConfigured(input.env)) {
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
	if (sources.length === 0) return empty('sources-unset')

	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const results: Array<D1PacedRestoreDrillSourceResult> = []
	for (const source of sources) {
		const db = resolvePacedD1Binding(input.env, source.binding)
		if (!db) continue
		results.push(
			await drillOneSource({
				s3,
				source,
				db,
				day,
			}),
		)
	}

	const sourcesOk = results.filter((result) => result.ok).length
	const drillResult: D1PacedRestoreDrillResult = {
		day,
		skipped: false,
		sourcesChecked: results.length,
		sourcesOk,
		sources: results,
	}
	const reportKey = await writeDrillReport({
		s3,
		day,
		result: drillResult,
		finishedAt: input.now.toISOString(),
	})
	drillResult.reportKey = reportKey
	console.info('dr_d1_paced_restore_drill', JSON.stringify(drillResult))
	if (results.length === 0) {
		throw new Error('paced D1 restore drill: no bound sources to check')
	}
	if (sourcesOk !== results.length) {
		const failed = results
			.filter((result) => !result.ok)
			.map((result) => `${result.databaseName}:${result.error ?? 'failed'}`)
			.join(', ')
		throw new Error(
			`paced D1 restore drill failed for ${day}: ${failed} (${sourcesOk}/${results.length} ok)`,
		)
	}
	return drillResult
}

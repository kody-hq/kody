import {
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedManifestKey,
	parsePacedD1NightManifest,
	type PacedD1NightManifest,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	applyPacedD1NightToState,
	buildPacedD1RestoreSql,
	createEmptyPacedD1RestoreState,
} from '@kody-internal/shared/backup-d1-paced-restore.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { isD1PacedBackupConfigured } from '#worker/dr/d1-paced-backup-schedule.ts'
import {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'
import {
	loadPacedD1TableDataBody,
	parsePacedD1PartsPointer,
} from '#worker/dr/d1-paced-backup-seal.ts'

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
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function utcDayMinus(day: string, daysBack: number) {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return date.toISOString().slice(0, 10)
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

async function nightUsesPartsPointer(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	table: string
}): Promise<boolean> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const key = pacedD1SealedDataKey(
		tier,
		input.source.id,
		input.day,
		input.table,
	)
	const text = await input.s3.getText(key)
	if (!text) return false
	return parsePacedD1PartsPointer(text.text) !== null
}

async function loadNightArtifacts(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	manifest: PacedD1NightManifest
	raw: string
}): Promise<{
	dataByTable: Record<string, string>
	anyParts: boolean
}> {
	const dataByTable: Record<string, string> = {}
	let anyParts = false
	for (const [table, tableManifest] of Object.entries(input.manifest.tables)) {
		if (
			await nightUsesPartsPointer({
				s3: input.s3,
				source: input.source,
				day: input.manifest.day,
				table,
			})
		) {
			anyParts = true
		}
		dataByTable[table] = await loadPacedD1TableDataBody({
			s3: input.s3,
			location: 'sealed',
			day: input.manifest.day,
			databaseName: input.source.name,
			databaseId: input.source.id,
			table,
			expectedSha256: tableManifest.dataSha256,
			kind: 'data',
		})
		await loadPacedD1TableDataBody({
			s3: input.s3,
			location: 'sealed',
			day: input.manifest.day,
			databaseName: input.source.name,
			databaseId: input.source.id,
			table,
			expectedSha256: tableManifest.indexSha256,
			kind: 'index',
		})
	}
	return { dataByTable, anyParts }
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

function restoreStateChecksumOk(
	rows: Map<number, { h: string }>,
	expectedCount: number,
	expectedChecksum: string,
): boolean {
	let sum = 0n
	for (const { h } of rows.values()) {
		sum = (sum + BigInt(`0x${h.slice(0, 16)}`)) & 0xffffffffffffffffn
	}
	const checksum = sum.toString(16).padStart(16, '0')
	return rows.size === expectedCount && checksum === expectedChecksum
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
	const state = createEmptyPacedD1RestoreState()
	let prevRaw: string | undefined
	for (const night of chain) {
		const { dataByTable, anyParts } = await loadNightArtifacts({
			s3: input.s3,
			source: input.source,
			manifest: night.manifest,
			raw: night.raw,
		})
		// Parts-chain digests are verified in loadPacedD1TableDataBody; the
		// assembled TSV sha will not match manifest.dataSha256, so skip the
		// artifact-body sha check while still verifying row hashes when possible.
		// First night in the chain may still cite an older prevManifestSha256;
		// omit prevManifestRaw so apply does not require that older night.
		await applyPacedD1NightToState({
			state,
			night: {
				manifest: night.manifest,
				manifestRaw: night.raw,
				dataByTable,
			},
			...(prevRaw === undefined ? {} : { prevManifestRaw: prevRaw }),
			verify: !anyParts,
		})
		if (anyParts) {
			for (const [table, tableManifest] of Object.entries(
				night.manifest.tables,
			)) {
				const rows = state.tables.get(table) ?? new Map()
				if (
					!restoreStateChecksumOk(
						rows,
						tableManifest.count,
						tableManifest.checksum,
					)
				) {
					throw new Error(
						`VERIFY FAILED on ${table} after parts restore for ${input.source.name}`,
					)
				}
			}
		}
		prevRaw = night.raw
	}

	const { stats } = buildPacedD1RestoreSql(state)
	const tables: Array<D1PacedRestoreDrillTableResult> = []
	let ok = true
	for (const [table, tableManifest] of Object.entries(tip.manifest.tables)) {
		const restored = state.tables.get(table) ?? new Map()
		const checksumOk = restoreStateChecksumOk(
			restored,
			tableManifest.count,
			tableManifest.checksum,
		)
		// Live COUNT(*) is advisory only: the tip bookmark is taken at night
		// start while the walker reads over the rest of the window, so inserts
		// mid-walk (especially AUDIT_DB) make exact equality unreliable. Pass
		// or fail on sealed-chain restore checksums and restored row counts.
		const liveCount = await countLiveTable(
			input.db,
			table,
			tip.manifest.timeTravelBookmark,
		)
		const tableOk = checksumOk && restored.size === tableManifest.count
		if (!tableOk) ok = false
		tables.push({
			table,
			manifestCount: tableManifest.count,
			restoredCount: restored.size,
			liveCount,
			ok: tableOk,
			error: tableOk
				? undefined
				: !checksumOk
					? 'restore-checksum-mismatch'
					: 'count-mismatch',
		})
	}

	return {
		databaseName: input.source.name,
		databaseId: input.source.id,
		day: tip.manifest.day,
		manifestKey: tip.key,
		nightsApplied: chain.length,
		tables,
		restoreStatements: stats.statements,
		ok,
		error: ok ? undefined : 'table-mismatch',
	}
}

/**
 * Weekly drill: load sealed paced night(s) for each configured source (full
 * base + deltas), rebuild restore state, emit restore SQL, and compare live
 * `SELECT COUNT(*)` (preferring the tip night's time-travel bookmark) to
 * manifest counts. Throws on mismatch so the scheduled lane surfaces in Sentry.
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

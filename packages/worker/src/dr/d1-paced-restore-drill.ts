import * as Sentry from '@sentry/cloudflare'
import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	applyPacedRestoreDrillSentryScope,
	pacedRestoreDrillLane,
	type PacedRestoreDrillCheckpoint,
	type PacedRestoreDrillFailureKind,
} from '@kody-internal/shared/backup-d1-paced-drill-alert.ts'
import { parsePacedD1DataLine } from '@kody-internal/shared/backup-d1-paced-encode.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import {
	isD1PacedRestoreDrillConfigured,
	isPastD1PacedRestoreDrillDeadline,
} from '#worker/dr/d1-paced-backup-schedule.ts'
import {
	parseD1PacedSources,
	resolvePacedD1Binding,
	type PacedD1SourceConfig,
} from '#worker/dr/d1-paced-backup-sources.ts'
import {
	loadVerifiedPacedD1NightChain,
	streamSealedPacedD1TableLines,
	type SealedPacedD1Night,
} from '@kody-internal/shared/backup-d1-paced-read.ts'
import {
	checkpointD1PacedRestoreDrillSource,
	claimD1PacedRestoreDrillLease,
	ensureD1PacedRestoreDrillRun,
	finishD1PacedRestoreDrillRun,
	finishD1PacedRestoreDrillSource,
	readD1PacedRestoreDrillRun,
	readD1PacedRestoreDrillSources,
	recordD1PacedRestoreDrillInterruption,
	releaseD1PacedRestoreDrillLease,
	setD1PacedRestoreDrillSourceActive,
	type D1PacedRestoreDrillSourceRow,
} from '#worker/dr/d1-paced-restore-drill-progress.ts'

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
	/** True once every bound source has a final result. */
	complete: boolean
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

const checksumMask = 0xffffffffffffffffn

/**
 * Parse a data line into primitives only (rowid number + 64-bit hash prefix).
 * Keeping `parsed.h` would keep a V8 sliced string that pins the whole part
 * body in memory, which is how the first drill held every APP_DB part at once.
 */
function readCompactLine(line: string): { rowid: number; hash: bigint | null } {
	const parsed = parsePacedD1DataLine(line)
	const rowid = Number(parsed.k[0])
	if (parsed.kind === 'D') return { rowid, hash: null }
	return { rowid, hash: BigInt(`0x${parsed.h.slice(0, 16)}`) }
}

export type D1PacedRestoreDrillPhase =
	| 'chain'
	| 'deltas'
	| 'base'
	| 'live-count'

/**
 * Verify one table's tip checksum with memory bounded by one part body plus
 * the rows touched by deltas since the last `full` base:
 * 1) stream delta nights into rowid -> hash (null = deleted),
 * 2) stream the base, summing hashes of rows the deltas did not touch,
 * 3) add surviving delta hashes.
 * Same result as replaying the chain into a rowid map, without the map.
 */
async function drillOneTable(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	db: D1Database
	chain: Array<SealedPacedD1Night>
	table: string
	onPhase: (phase: D1PacedRestoreDrillPhase) => Promise<void>
	onPart?: () => Promise<void>
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

	// Progress-store failures (D1 busy, lease renew) are not table verdicts:
	// rethrow them so the tick fails and the marker is retried next tick.
	const progressFailure: { error?: unknown } = {}
	const trackProgress =
		<Args extends Array<unknown>>(write: (...args: Args) => Promise<void>) =>
		async (...args: Args) => {
			try {
				await write(...args)
			} catch (error) {
				progressFailure.error = error
				throw error
			}
		}
	const onPhase = trackProgress(input.onPhase)
	const onPart = input.onPart ? trackProgress(input.onPart) : undefined

	try {
		// A night that omits the table drops it, so only the trailing run of
		// nights that include it matters; its last `full` night is the base.
		let segmentStart = 0
		input.chain.forEach((night, index) => {
			if (!night.manifest.tables[input.table]) segmentStart = index + 1
		})
		let baseIndex = -1
		for (let index = segmentStart; index < input.chain.length; index += 1) {
			if (input.chain[index]!.manifest.tables[input.table]!.mode === 'full') {
				baseIndex = index
			}
		}

		await onPhase('deltas')
		const touched = new Map<number, bigint | null>()
		const deltaStart = baseIndex >= 0 ? baseIndex + 1 : segmentStart
		for (let index = deltaStart; index < input.chain.length; index += 1) {
			const night = input.chain[index]!
			await streamSealedPacedD1TableLines({
				reader: input.s3,
				source: input.source,
				day: night.manifest.day,
				table: input.table,
				tableManifest: night.manifest.tables[input.table]!,
				onLine: (line) => {
					const { rowid, hash } = readCompactLine(line)
					touched.set(rowid, hash)
				},
				onPart,
			})
		}

		await onPhase('base')
		let sum = 0n
		let restoredCount = 0
		if (baseIndex >= 0) {
			const base = input.chain[baseIndex]!
			// A restore replays lines into a rowid map, so a rowid the base
			// carries twice restores once with its last line. Bases are written
			// in rowid order, so the first pass only notes rowids that arrive
			// out of order; a base with any is streamed again to settle them.
			const streamBase = async (repeated: ReadonlySet<number> | null) => {
				const lastLine = new Map<number, bigint>()
				const outOfOrder = new Set<number>()
				let maxRowid = -Infinity
				sum = 0n
				restoredCount = 0
				await streamSealedPacedD1TableLines({
					reader: input.s3,
					source: input.source,
					day: base.manifest.day,
					table: input.table,
					tableManifest: base.manifest.tables[input.table]!,
					onLine: (line) => {
						const { rowid, hash } = readCompactLine(line)
						if (hash === null) {
							throw new Error(
								`paced D1 unexpected delete line in full base for ${input.source.name}.${input.table}`,
							)
						}
						if (rowid <= maxRowid) outOfOrder.add(rowid)
						else maxRowid = rowid
						if (touched.has(rowid)) return
						if (repeated?.has(rowid)) {
							lastLine.set(rowid, hash)
							return
						}
						sum = (sum + hash) & checksumMask
						restoredCount += 1
					},
					onPart,
				})
				for (const hash of lastLine.values()) {
					sum = (sum + hash) & checksumMask
					restoredCount += 1
				}
				return outOfOrder
			}
			const outOfOrder = await streamBase(null)
			if (outOfOrder.size > 0) await streamBase(outOfOrder)
		}
		for (const hash of touched.values()) {
			if (hash === null) continue
			sum = (sum + hash) & checksumMask
			restoredCount += 1
		}
		const checksum = sum.toString(16).padStart(16, '0')
		const tableOk =
			restoredCount === tipManifest.count && checksum === tipManifest.checksum

		await onPhase('live-count')
		const liveCount = await countLiveTable(
			input.db,
			input.table,
			tip.manifest.timeTravelBookmark,
		)
		return {
			table: input.table,
			manifestCount: tipManifest.count,
			restoredCount,
			liveCount,
			ok: tableOk,
			error: tableOk ? undefined : 'restore-checksum-mismatch',
		}
	} catch (error) {
		if ('error' in progressFailure) throw progressFailure.error
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

/** Thrown for drill failures so the lane catch applies the drill fingerprint. */
export class D1PacedRestoreDrillError extends Error {
	readonly kind: PacedRestoreDrillFailureKind
	readonly checkpoint: PacedRestoreDrillCheckpoint
	constructor(
		message: string,
		input: {
			kind: PacedRestoreDrillFailureKind
			checkpoint: PacedRestoreDrillCheckpoint
		},
	) {
		super(message)
		this.name = 'D1PacedRestoreDrillError'
		this.kind = input.kind
		this.checkpoint = input.checkpoint
	}
}

const defaultTickBudgetMs = 4 * 60_000
const leaseMs = 6 * 60_000
const leaseRenewEveryMs = 30_000

function captureDrillInterruption(checkpoint: PacedRestoreDrillCheckpoint) {
	console.error('dr_d1_paced_restore_drill_interrupted', checkpoint)
	Sentry.withScope((scope) => {
		scope.setTag('scheduled.lane', pacedRestoreDrillLane)
		applyPacedRestoreDrillSentryScope(scope, {
			kind: 'interrupted',
			checkpoint,
		})
		Sentry.captureMessage(
			`paced D1 restore drill interrupted: ${checkpoint.source ?? 'unknown'} ${checkpoint.phase ?? 'unknown'}${checkpoint.table ? ` ${checkpoint.table}` : ''}`,
			'fatal',
		)
	})
}

function sourceResultFromRow(
	row: D1PacedRestoreDrillSourceRow,
): D1PacedRestoreDrillSourceResult {
	if (isRecord(row.result)) {
		return row.result as D1PacedRestoreDrillSourceResult
	}
	return {
		databaseName: row.databaseName,
		databaseId: row.databaseId,
		day: row.day,
		manifestKey: '',
		nightsApplied: 0,
		tables: row.tables,
		restoreStatements: 0,
		ok: row.status === 'passed',
		error: row.error ?? undefined,
	}
}

function isTerminal(row: D1PacedRestoreDrillSourceRow | undefined) {
	return row?.status === 'passed' || row?.status === 'failed'
}

/**
 * Drill one source for at most one tick budget, checkpointing after every
 * table. Returns when the source finishes or the budget runs out.
 */
async function drillSourceSlice(input: {
	s3: DrBackupS3Client
	progressDb: D1Database
	source: PacedD1SourceConfig
	db: D1Database
	day: string
	row: D1PacedRestoreDrillSourceRow
	clock: () => number
	deadlineMs: number
	renewLease: () => Promise<void>
}) {
	const nowIso = () => new Date(input.clock()).toISOString()
	const setPhase = (table: string | null, phase: D1PacedRestoreDrillPhase) =>
		setD1PacedRestoreDrillSourceActive(input.progressDb, {
			day: input.day,
			databaseId: input.source.id,
			table,
			phase,
			nowIso: nowIso(),
		})
	const finish = async (result: D1PacedRestoreDrillSourceResult) => {
		await finishD1PacedRestoreDrillSource(input.progressDb, {
			day: input.day,
			databaseId: input.source.id,
			status: result.ok ? 'passed' : 'failed',
			tables: result.tables,
			result,
			error: result.error ?? null,
			nowIso: nowIso(),
		})
	}

	await setPhase(null, 'chain')
	let chain: Array<SealedPacedD1Night>
	try {
		chain = await loadVerifiedPacedD1NightChain({
			reader: input.s3,
			source: input.source,
			day: input.day,
		})
	} catch (error) {
		await finish({
			databaseName: input.source.name,
			databaseId: input.source.id,
			day: input.day,
			manifestKey: '',
			nightsApplied: 0,
			tables: input.row.tables,
			restoreStatements: 0,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		})
		return
	}
	if (chain.length === 0) {
		await finish({
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
		})
		return
	}

	const tip = chain[chain.length - 1]!
	const tables = [...input.row.tables]
	const done = new Set(tables.map((table) => table.table))
	for (const table of Object.keys(tip.manifest.tables)) {
		if (done.has(table)) continue
		if (input.clock() >= input.deadlineMs) {
			await checkpointD1PacedRestoreDrillSource(input.progressDb, {
				day: input.day,
				databaseId: input.source.id,
				tables,
				nowIso: nowIso(),
			})
			return
		}
		const result = await drillOneTable({
			s3: input.s3,
			source: input.source,
			db: input.db,
			chain,
			table,
			onPhase: (phase) => setPhase(table, phase),
			onPart: input.renewLease,
		})
		tables.push(result)
		await checkpointD1PacedRestoreDrillSource(input.progressDb, {
			day: input.day,
			databaseId: input.source.id,
			tables,
			nowIso: nowIso(),
		})
	}

	const ok = tables.every((table) => table.ok)
	await finish({
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
	})
}

/**
 * Weekly drill, resumable across cron ticks. Each tick takes a D1 lease,
 * reports any tick that died mid-table (OOM/timeout) to Sentry with source and
 * phase, drills the next unfinished source for one budget with per-table
 * checkpoints in APP_DB, and once every source is done writes the R2 report
 * and throws on mismatch so the lane alerts.
 */
export async function runD1PacedRestoreDrillTick(input: {
	env: Env
	now: Date
	s3?: DrBackupS3Client
	/** Override which UTC day to drill (defaults to yesterday). */
	day?: string
	/** Wall-clock budget for this tick (defaults to 4 minutes). */
	budgetMs?: number
	clock?: () => number
}): Promise<D1PacedRestoreDrillResult> {
	const today = formatUtcDay(input.now)
	const day = input.day ?? utcDayMinus(today, 1)
	const startMs = input.now.getTime()
	const wallStart = Date.now()
	const clock = input.clock ?? (() => startMs + (Date.now() - wallStart))
	const empty = (reason: string): D1PacedRestoreDrillResult => ({
		day,
		skipped: true,
		reason,
		complete: false,
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

	const bound = sources.flatMap((source) => {
		const db = resolvePacedD1Binding(input.env, source.binding)
		return db ? [{ source, db }] : []
	})
	if (bound.length === 0) {
		throw new D1PacedRestoreDrillError(
			'paced D1 restore drill: no bound sources to check',
			{
				kind: 'error',
				checkpoint: { day, source: null, table: null, phase: null },
			},
		)
	}

	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const progressDb = input.env.APP_DB
	const nowIso = () => new Date(clock()).toISOString()
	await ensureD1PacedRestoreDrillRun(progressDb, {
		day,
		sources: bound.map(({ source }) => source),
		nowIso: nowIso(),
	})

	const summarize = (
		rows: Array<D1PacedRestoreDrillSourceRow>,
		extra: Partial<D1PacedRestoreDrillResult>,
	): D1PacedRestoreDrillResult => {
		const finished = bound.flatMap(({ source }) => {
			const row = rows.find((entry) => entry.databaseId === source.id)
			return row && isTerminal(row) ? [sourceResultFromRow(row)] : []
		})
		return {
			day,
			skipped: false,
			complete: finished.length === bound.length,
			sourcesChecked: bound.length,
			sourcesOk: finished.filter((result) => result.ok).length,
			sources: finished,
			...extra,
		}
	}

	const run = await readD1PacedRestoreDrillRun(progressDb, day)
	if (run && run.status !== 'running') {
		return summarize(await readD1PacedRestoreDrillSources(progressDb, day), {
			skipped: true,
			reason: 'already-finished',
			reportKey: run.reportKey ?? undefined,
		})
	}

	const token = crypto.randomUUID()
	const claimed = await claimD1PacedRestoreDrillLease(progressDb, {
		day,
		token,
		nowMs: clock(),
		leaseMs,
	})
	if (!claimed) {
		return summarize(await readD1PacedRestoreDrillSources(progressDb, day), {
			skipped: true,
			reason: 'lease-held',
		})
	}
	let lastRenewMs = clock()
	const renewLease = async () => {
		if (clock() - lastRenewMs < leaseRenewEveryMs) return
		lastRenewMs = clock()
		await claimD1PacedRestoreDrillLease(progressDb, {
			day,
			token,
			nowMs: lastRenewMs,
			leaseMs,
		})
	}

	try {
		let rows = await readD1PacedRestoreDrillSources(progressDb, day)
		// An active marker under an expired lease means the previous tick died
		// mid-phase (isolate OOM / CPU / wall limit). Report it with source and
		// phase; a second death on the same source fails the table it died on.
		for (const row of rows) {
			if (row.status !== 'running' || row.activePhase === null) continue
			captureDrillInterruption({
				day,
				source: row.databaseName,
				table: row.activeTable,
				phase: row.activePhase,
			})
			await recordD1PacedRestoreDrillInterruption(progressDb, {
				day,
				databaseId: row.databaseId,
				nowIso: nowIso(),
			})
			// Retry once per table: fail only a repeat death on the same table.
			if (row.lastInterruptedTable !== (row.activeTable ?? '(chain)')) continue
			const error = `interrupted-${row.activePhase}`
			if (row.activeTable === null) {
				await finishD1PacedRestoreDrillSource(progressDb, {
					day,
					databaseId: row.databaseId,
					status: 'failed',
					tables: row.tables,
					result: null,
					error,
					nowIso: nowIso(),
				})
				continue
			}
			await checkpointD1PacedRestoreDrillSource(progressDb, {
				day,
				databaseId: row.databaseId,
				tables: [
					...row.tables,
					{
						table: row.activeTable,
						manifestCount: 0,
						restoredCount: 0,
						liveCount: null,
						ok: false,
						error,
					},
				],
				nowIso: nowIso(),
			})
		}
		rows = await readD1PacedRestoreDrillSources(progressDb, day)

		const pastDeadline =
			input.day === undefined && isPastD1PacedRestoreDrillDeadline(input.now)
		const next = bound.find(
			({ source }) =>
				!isTerminal(rows.find((row) => row.databaseId === source.id)),
		)
		if (next && pastDeadline) {
			for (const { source } of bound) {
				const row = rows.find((entry) => entry.databaseId === source.id)
				if (isTerminal(row)) continue
				await finishD1PacedRestoreDrillSource(progressDb, {
					day,
					databaseId: source.id,
					status: 'failed',
					tables: row?.tables ?? [],
					result: null,
					error: 'deadline-exceeded',
					nowIso: nowIso(),
				})
			}
		} else if (next) {
			const row = rows.find((entry) => entry.databaseId === next.source.id)!
			await drillSourceSlice({
				s3,
				progressDb,
				source: next.source,
				db: next.db,
				day,
				row,
				clock,
				deadlineMs: clock() + (input.budgetMs ?? defaultTickBudgetMs),
				renewLease,
			})
		}

		rows = await readD1PacedRestoreDrillSources(progressDb, day)
		const inProgress = summarize(rows, {})
		if (!inProgress.complete) {
			console.info(
				'dr_d1_paced_restore_drill_progress',
				JSON.stringify({
					day,
					sources: rows.map((row) => ({
						source: row.databaseName,
						status: row.status,
						tablesDone: row.tables.length,
					})),
				}),
			)
			return { ...inProgress, reason: 'in-progress' }
		}

		const drillResult = inProgress
		try {
			drillResult.reportKey = await writeDrillReport({
				s3,
				day,
				result: drillResult,
				finishedAt: nowIso(),
			})
		} catch (error) {
			console.error('dr_d1_paced_restore_drill_report_failed', error)
		}
		const failedSources = drillResult.sources.filter((result) => !result.ok)
		const failedSummary = failedSources
			.map((result) => `${result.databaseName}:${result.error ?? 'failed'}`)
			.join(', ')
		await finishD1PacedRestoreDrillRun(progressDb, {
			day,
			status: failedSources.length === 0 ? 'passed' : 'failed',
			sourcesTotal: bound.length,
			sourcesOk: drillResult.sourcesOk,
			reportKey: drillResult.reportKey ?? null,
			error: failedSources.length === 0 ? null : failedSummary,
			nowIso: nowIso(),
		})
		console.info('dr_d1_paced_restore_drill', JSON.stringify(drillResult))
		// A real mismatch outranks a deadline miss for grouping.
		const firstFailed =
			failedSources.find((result) => result.error !== 'deadline-exceeded') ??
			failedSources[0]
		if (firstFailed) {
			const failedTable = firstFailed.tables.find((table) => !table.ok)
			throw new D1PacedRestoreDrillError(
				`paced D1 restore drill failed for ${day}: ${failedSummary} (${drillResult.sourcesOk}/${bound.length} ok)`,
				{
					kind:
						firstFailed.error === 'deadline-exceeded' ? 'deadline' : 'mismatch',
					checkpoint: {
						day,
						source: firstFailed.databaseName,
						table: failedTable?.table ?? null,
						phase: 'verify',
					},
				},
			)
		}
		return drillResult
	} finally {
		await releaseD1PacedRestoreDrillLease(progressDb, { day, token })
	}
}

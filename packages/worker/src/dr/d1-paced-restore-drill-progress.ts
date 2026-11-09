import type { PacedRestoreDrillCheckpoint } from '@kody-internal/shared/backup-d1-paced-drill-alert.ts'

/**
 * D1 (APP_DB) progress rows for the weekly paced restore drill. Each tick
 * resumes from these rows, and `/__maintenance/dr-paced-status` reads them so
 * per-source progress is visible without opening the R2 report.
 */

export type D1PacedRestoreDrillRunStatus = 'running' | 'passed' | 'failed'
export type D1PacedRestoreDrillSourceStatus =
	| 'pending'
	| 'running'
	| 'passed'
	| 'failed'

export type D1PacedRestoreDrillTableProgress = {
	table: string
	manifestCount: number
	restoredCount: number
	liveCount: number | null
	ok: boolean
	error?: string
}

export type D1PacedRestoreDrillRunRow = {
	day: string
	status: D1PacedRestoreDrillRunStatus
	sourcesTotal: number
	sourcesOk: number
	reportKey: string | null
	error: string | null
	startedAt: string
	updatedAt: string
	finishedAt: string | null
}

export type D1PacedRestoreDrillSourceRow = {
	day: string
	databaseId: string
	databaseName: string
	status: D1PacedRestoreDrillSourceStatus
	activeTable: string | null
	activePhase: string | null
	interruptedCount: number
	/** Table (or `(chain)`) the most recent dead tick was on. */
	lastInterruptedTable: string | null
	tables: Array<D1PacedRestoreDrillTableProgress>
	/** Final source result JSON (set when the source finishes). */
	result: unknown
	error: string | null
	startedAt: string
	updatedAt: string
	finishedAt: string | null
}

type RunDbRow = {
	day: string
	status: string
	sources_total: number
	sources_ok: number
	report_key: string | null
	error: string | null
	started_at: string
	updated_at: string
	finished_at: string | null
}

type SourceDbRow = {
	day: string
	database_id: string
	database_name: string
	status: string
	active_table: string | null
	active_phase: string | null
	interrupted_count: number
	last_interrupted_table: string | null
	tables_json: string
	result_json: string | null
	error: string | null
	started_at: string
	updated_at: string
	finished_at: string | null
}

function parseTables(text: string): Array<D1PacedRestoreDrillTableProgress> {
	try {
		const parsed = JSON.parse(text) as unknown
		return Array.isArray(parsed)
			? (parsed as Array<D1PacedRestoreDrillTableProgress>)
			: []
	} catch {
		return []
	}
}

function parseResult(text: string | null): unknown {
	if (!text) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function toRun(row: RunDbRow): D1PacedRestoreDrillRunRow {
	return {
		day: row.day,
		status: row.status as D1PacedRestoreDrillRunStatus,
		sourcesTotal: Number(row.sources_total),
		sourcesOk: Number(row.sources_ok),
		reportKey: row.report_key,
		error: row.error,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
		finishedAt: row.finished_at,
	}
}

function toSource(row: SourceDbRow): D1PacedRestoreDrillSourceRow {
	return {
		day: row.day,
		databaseId: row.database_id,
		databaseName: row.database_name,
		status: row.status as D1PacedRestoreDrillSourceStatus,
		activeTable: row.active_table,
		activePhase: row.active_phase,
		interruptedCount: Number(row.interrupted_count),
		lastInterruptedTable: row.last_interrupted_table,
		tables: parseTables(row.tables_json),
		result: parseResult(row.result_json),
		error: row.error,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
		finishedAt: row.finished_at,
	}
}

export async function ensureD1PacedRestoreDrillRun(
	db: D1Database,
	input: {
		day: string
		sources: Array<{ id: string; name: string }>
		nowIso: string
	},
) {
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO dr_paced_restore_drill_runs
				(day, status, sources_total, started_at, updated_at)
				VALUES (?, 'running', ?, ?, ?)`,
			)
			.bind(input.day, input.sources.length, input.nowIso, input.nowIso),
		...input.sources.map((source) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO dr_paced_restore_drill_sources
					(day, database_id, database_name, status, started_at, updated_at)
					VALUES (?, ?, ?, 'pending', ?, ?)`,
				)
				.bind(input.day, source.id, source.name, input.nowIso, input.nowIso),
		),
	])
}

/** Claim (or renew) the single-writer lease for a running drill day. */
export async function claimD1PacedRestoreDrillLease(
	db: D1Database,
	input: { day: string; token: string; nowMs: number; leaseMs: number },
) {
	const result = await db
		.prepare(
			`UPDATE dr_paced_restore_drill_runs
			SET lease_token = ?, lease_until = ?
			WHERE day = ? AND status = 'running'
				AND (lease_token = ? OR lease_until IS NULL OR lease_until < ?)`,
		)
		.bind(
			input.token,
			input.nowMs + input.leaseMs,
			input.day,
			input.token,
			input.nowMs,
		)
		.run()
	return (result.meta.changes ?? 0) === 1
}

export async function releaseD1PacedRestoreDrillLease(
	db: D1Database,
	input: { day: string; token: string },
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_runs
			SET lease_token = NULL, lease_until = NULL
			WHERE day = ? AND lease_token = ?`,
		)
		.bind(input.day, input.token)
		.run()
}

export async function readD1PacedRestoreDrillRun(
	db: D1Database,
	day: string,
): Promise<D1PacedRestoreDrillRunRow | null> {
	const row = await db
		.prepare(`SELECT * FROM dr_paced_restore_drill_runs WHERE day = ?`)
		.bind(day)
		.first<RunDbRow>()
	return row ? toRun(row) : null
}

export async function readD1PacedRestoreDrillSources(
	db: D1Database,
	day: string,
): Promise<Array<D1PacedRestoreDrillSourceRow>> {
	const result = await db
		.prepare(
			`SELECT * FROM dr_paced_restore_drill_sources WHERE day = ?
			ORDER BY started_at, database_name`,
		)
		.bind(day)
		.all<SourceDbRow>()
	return result.results.map(toSource)
}

export async function setD1PacedRestoreDrillSourceActive(
	db: D1Database,
	input: {
		day: string
		databaseId: string
		table: string | null
		phase: string
		nowIso: string
	},
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_sources
			SET status = 'running', active_table = ?, active_phase = ?, updated_at = ?
			WHERE day = ? AND database_id = ?`,
		)
		.bind(input.table, input.phase, input.nowIso, input.day, input.databaseId)
		.run()
}

/** Persist finished tables and clear the active marker (clean checkpoint). */
export async function checkpointD1PacedRestoreDrillSource(
	db: D1Database,
	input: {
		day: string
		databaseId: string
		tables: Array<D1PacedRestoreDrillTableProgress>
		nowIso: string
	},
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_sources
			SET tables_json = ?, active_table = NULL, active_phase = NULL, updated_at = ?
			WHERE day = ? AND database_id = ?`,
		)
		.bind(
			JSON.stringify(input.tables),
			input.nowIso,
			input.day,
			input.databaseId,
		)
		.run()
}

export async function recordD1PacedRestoreDrillInterruption(
	db: D1Database,
	input: { day: string; databaseId: string; nowIso: string },
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_sources
			SET interrupted_count = interrupted_count + 1,
				last_interrupted_table = COALESCE(active_table, '(chain)'),
				active_table = NULL,
				active_phase = NULL, updated_at = ?
			WHERE day = ? AND database_id = ?`,
		)
		.bind(input.nowIso, input.day, input.databaseId)
		.run()
}

export async function finishD1PacedRestoreDrillSource(
	db: D1Database,
	input: {
		day: string
		databaseId: string
		status: 'passed' | 'failed'
		tables: Array<D1PacedRestoreDrillTableProgress>
		result: unknown
		error: string | null
		nowIso: string
	},
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_sources
			SET status = ?, tables_json = ?, result_json = ?, error = ?, active_table = NULL,
				active_phase = NULL, updated_at = ?, finished_at = ?
			WHERE day = ? AND database_id = ?`,
		)
		.bind(
			input.status,
			JSON.stringify(input.tables),
			JSON.stringify(input.result),
			input.error,
			input.nowIso,
			input.nowIso,
			input.day,
			input.databaseId,
		)
		.run()
}

export async function finishD1PacedRestoreDrillRun(
	db: D1Database,
	input: {
		day: string
		status: 'passed' | 'failed'
		sourcesTotal: number
		sourcesOk: number
		reportKey: string | null
		error: string | null
		nowIso: string
	},
) {
	await db
		.prepare(
			`UPDATE dr_paced_restore_drill_runs
			SET status = ?, sources_total = ?, sources_ok = ?, report_key = ?,
				error = ?, lease_token = NULL, lease_until = NULL, updated_at = ?,
				finished_at = ?
			WHERE day = ?`,
		)
		.bind(
			input.status,
			input.sourcesTotal,
			input.sourcesOk,
			input.reportKey,
			input.error,
			input.nowIso,
			input.nowIso,
			input.day,
		)
		.run()
}

export type D1PacedRestoreDrillProgress = {
	run: D1PacedRestoreDrillRunRow
	sources: Array<D1PacedRestoreDrillSourceRow>
}

/** Most recent drill day with its per-source rows (admin status + Sentry). */
export async function readLatestD1PacedRestoreDrill(
	db: D1Database,
): Promise<D1PacedRestoreDrillProgress | null> {
	const row = await db
		.prepare(
			`SELECT * FROM dr_paced_restore_drill_runs ORDER BY day DESC LIMIT 1`,
		)
		.first<RunDbRow>()
	if (!row) return null
	return {
		run: toRun(row),
		sources: await readD1PacedRestoreDrillSources(db, row.day),
	}
}

/**
 * Where the latest drill is (or died): the source with an active marker, else
 * the first unfinished source. Used to tag platform OOM/timeout events that
 * the drill itself cannot report.
 */
export function pacedRestoreDrillCheckpointFromProgress(
	progress: D1PacedRestoreDrillProgress | null,
): PacedRestoreDrillCheckpoint | null {
	if (!progress) return null
	const active =
		progress.sources.find((source) => source.activePhase !== null) ??
		progress.sources.find(
			(source) => source.status === 'running' || source.status === 'pending',
		) ??
		null
	return {
		day: progress.run.day,
		source: active?.databaseName ?? null,
		table: active?.activeTable ?? null,
		phase: active?.activePhase ?? null,
	}
}

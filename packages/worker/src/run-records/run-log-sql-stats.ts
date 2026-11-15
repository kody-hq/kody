/**
 * Per-statement SqlStorageCursor.rowsRead / rowsWritten accounting for the
 * RunLog Durable Object. Every statement goes through `wrap(sql).exec`, so a
 * new unindexed query shows up without opting in. Counters live in the
 * isolate only (no SQL writes); a periodic log line names the top statements
 * and any single statement that reads at least `largeScanRows` rows is
 * reported on its own.
 */

export type RunLogSqlStatementStats = {
	sql: string
	rowsRead: number
	rowsWritten: number
	calls: number
	maxRowsRead: number
}

export type RunLogSqlStatsSnapshot = {
	since: string
	rowsReadTotal: number
	rowsWrittenTotal: number
	statements: Array<RunLogSqlStatementStats>
}

export type RunLogSqlStatsWindow = {
	windowMs: number
	rowsRead: number
	rowsWritten: number
	top: Array<RunLogSqlStatementStats>
}

type RunLogSqlStatsHooks = {
	/** Rows read by one settled batch of statements. */
	onRowsRead: (rowsRead: number) => void
	onWindow: (window: RunLogSqlStatsWindow) => void
	onLargeScan: (scan: { sql: string; rowsRead: number }) => void
}

/** One statement reading this many rows is reported as a large scan. */
export const runLogSqlLargeScanRows = 5_000
export const runLogSqlStatsWindowMs = 60_000
const statementKeyMaxLength = 160
const maxDistinctStatements = 200
const overflowStatementKey = '(other statements)'
const topStatementsPerWindow = 10

export function runLogSqlStatementKey(query: string): string {
	return query.replace(/\s+/g, ' ').trim().slice(0, statementKeyMaxLength)
}

type PendingCursor = {
	key: string
	cursor: Pick<
		SqlStorageCursor<Record<string, SqlStorageValue>>,
		'rowsRead' | 'rowsWritten'
	>
}

function addTo(
	map: Map<string, RunLogSqlStatementStats>,
	key: string,
	rowsRead: number,
	rowsWritten: number,
) {
	let entry = map.get(key)
	if (!entry) {
		if (map.size >= maxDistinctStatements && key !== overflowStatementKey) {
			addTo(map, overflowStatementKey, rowsRead, rowsWritten)
			return
		}
		entry = { sql: key, rowsRead: 0, rowsWritten: 0, calls: 0, maxRowsRead: 0 }
		map.set(key, entry)
	}
	entry.rowsRead += rowsRead
	entry.rowsWritten += rowsWritten
	entry.calls += 1
	entry.maxRowsRead = Math.max(entry.maxRowsRead, rowsRead)
}

function byRowsReadDesc(
	a: RunLogSqlStatementStats,
	b: RunLogSqlStatementStats,
) {
	return b.rowsRead - a.rowsRead || b.calls - a.calls
}

export class RunLogSqlStats {
	private totals = new Map<string, RunLogSqlStatementStats>()
	private window = new Map<string, RunLogSqlStatementStats>()
	private largeScanReported = new Set<string>()
	private pending: Array<PendingCursor> = []
	private settleQueued = false
	private since = new Date().toISOString()
	private windowStartedAt = Date.now()

	private readonly hooks: RunLogSqlStatsHooks

	constructor(hooks: RunLogSqlStatsHooks) {
		this.hooks = hooks
	}

	wrap(sql: SqlStorage): SqlStorage {
		const track = (query: string, cursor: PendingCursor['cursor']) => {
			this.pending.push({ key: runLogSqlStatementKey(query), cursor })
			if (this.settleQueued) return
			this.settleQueued = true
			// Callers consume cursors synchronously (`exec(...).toArray()`), so
			// counters are final by the next microtask.
			queueMicrotask(() => this.settle())
		}
		return {
			exec<T extends Record<string, SqlStorageValue>>(
				query: string,
				...bindings: Array<unknown>
			) {
				const cursor = sql.exec<T>(query, ...bindings)
				track(query, cursor)
				return cursor
			},
			get databaseSize() {
				return sql.databaseSize
			},
			Cursor: sql.Cursor,
			Statement: sql.Statement,
		}
	}

	/** Fold pending cursors into the counters. Safe to call at any time. */
	settle() {
		this.settleQueued = false
		const pending = this.pending
		this.pending = []
		let batchRowsRead = 0
		for (const { key, cursor } of pending) {
			const rowsRead = Number(cursor.rowsRead) || 0
			const rowsWritten = Number(cursor.rowsWritten) || 0
			batchRowsRead += rowsRead
			addTo(this.totals, key, rowsRead, rowsWritten)
			addTo(this.window, key, rowsRead, rowsWritten)
			if (
				rowsRead >= runLogSqlLargeScanRows &&
				!this.largeScanReported.has(key)
			) {
				this.largeScanReported.add(key)
				this.hooks.onLargeScan({ sql: key, rowsRead })
			}
		}
		if (batchRowsRead > 0) this.hooks.onRowsRead(batchRowsRead)
		const now = Date.now()
		if (now - this.windowStartedAt >= runLogSqlStatsWindowMs) {
			this.flushWindow(now)
		}
	}

	private flushWindow(now: number) {
		const statements = [...this.window.values()]
		const windowMs = now - this.windowStartedAt
		this.window = new Map()
		this.largeScanReported.clear()
		this.windowStartedAt = now
		if (statements.length === 0) return
		let rowsRead = 0
		let rowsWritten = 0
		for (const entry of statements) {
			rowsRead += entry.rowsRead
			rowsWritten += entry.rowsWritten
		}
		this.hooks.onWindow({
			windowMs,
			rowsRead,
			rowsWritten,
			top: statements.sort(byRowsReadDesc).slice(0, topStatementsPerWindow),
		})
	}

	snapshot(): RunLogSqlStatsSnapshot {
		this.settle()
		const statements = [...this.totals.values()]
			.map((entry) => ({ ...entry }))
			.sort(byRowsReadDesc)
		let rowsReadTotal = 0
		let rowsWrittenTotal = 0
		for (const entry of statements) {
			rowsReadTotal += entry.rowsRead
			rowsWrittenTotal += entry.rowsWritten
		}
		return { since: this.since, rowsReadTotal, rowsWrittenTotal, statements }
	}

	reset() {
		this.pending = []
		this.totals = new Map()
		this.window = new Map()
		this.largeScanReported.clear()
		this.since = new Date().toISOString()
		this.windowStartedAt = Date.now()
	}
}

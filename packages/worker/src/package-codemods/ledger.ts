import {
	maxRestorableTextColumnBytes,
	truncateToUtf8Bytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type PackageCodemodFinding } from './types.ts'

export type PackageCodemodRunStatus =
	| 'running'
	| 'completed'
	| 'failed'
	| 'abandoned'

export type PackageCodemodRunRecord = {
	id: string
	codemodId: string
	mode: string
	scopeUserId: string | null
	initiatedByUserId: string
	filtersJson: string
	status: PackageCodemodRunStatus
	revertOfRunId: string | null
	createdAt: string
	updatedAt: string
}

export type PackageCodemodRunItemRecord = {
	id: string
	runId: string
	userId: OwnerId
	packageId: string
	kodyId: string
	status: string
	beforeCommit: string | null
	afterCommit: string | null
	changedPaths: Array<string>
	findings: Array<PackageCodemodFinding>
	checkSummaryJson: string | null
	error: string | null
	revertSnapshotKey: string | null
	/** Owner-private codemod detail (admin-only); see `ownerDetail`. */
	ownerDetailJson: string | null
	createdAt: string
	updatedAt: string
}

const runSelectColumns = `id, codemod_id, mode, scope_user_id, initiated_by_user_id,
	filters_json, status, revert_of_run_id, created_at, updated_at`

const itemSelectColumns = `id, run_id, user_id, package_id, kody_id, status,
	before_commit, after_commit, changed_paths_json, findings_json,
	check_summary_json, error, revert_snapshot_key, owner_detail_json, created_at,
	updated_at`

const maxFindingsStored = 50
const maxChangedPathsStored = 200
const truncationNotice = '\n…[truncated]'

function parseJsonArray<T>(value: string | null | undefined): Array<T> {
	if (value == null || value === '') return []
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) ? (parsed as Array<T>) : []
	} catch {
		return []
	}
}

function boundTextColumn(value: string | null | undefined): string | null {
	if (value == null) return null
	if (utf8ByteLength(value) <= maxRestorableTextColumnBytes) return value
	return (
		truncateToUtf8Bytes(
			value,
			maxRestorableTextColumnBytes - utf8ByteLength(truncationNotice),
		) + truncationNotice
	)
}

function boundJsonStringArray(values: Array<string>): string {
	const capped = values.slice(0, maxChangedPathsStored)
	for (let size = capped.length; size >= 0; size -= 1) {
		const slice = capped.slice(0, size)
		const payload =
			size < values.length
				? [...slice, `…truncated ${values.length - size} more`]
				: slice
		const json = JSON.stringify(payload)
		if (utf8ByteLength(json) <= maxRestorableTextColumnBytes) {
			return json
		}
	}
	return JSON.stringify(['…truncated'])
}

function boundFindingsJson(findings: Array<PackageCodemodFinding>): string {
	const capped = findings.slice(0, maxFindingsStored)
	for (let size = capped.length; size >= 0; size -= 1) {
		const slice = capped.slice(0, size)
		const payload =
			size < findings.length
				? [
						...slice,
						{
							path: null,
							message: `…truncated ${findings.length - size} more findings`,
						},
					]
				: slice
		const json = JSON.stringify(payload)
		if (utf8ByteLength(json) <= maxRestorableTextColumnBytes) {
			return json
		}
	}
	return JSON.stringify([
		{
			path: null,
			message: 'findings truncated',
		},
	])
}

function mapRunRow(row: Record<string, unknown>): PackageCodemodRunRecord {
	const status = String(row['status'])
	return {
		id: String(row['id']),
		codemodId: String(row['codemod_id']),
		mode: String(row['mode']),
		scopeUserId:
			row['scope_user_id'] == null ? null : String(row['scope_user_id']),
		initiatedByUserId: String(row['initiated_by_user_id']),
		filtersJson: String(row['filters_json'] ?? '{}'),
		status:
			status === 'completed' ||
			status === 'failed' ||
			status === 'running' ||
			status === 'abandoned'
				? status
				: 'failed',
		revertOfRunId:
			row['revert_of_run_id'] == null ? null : String(row['revert_of_run_id']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapItemRow(row: Record<string, unknown>): PackageCodemodRunItemRecord {
	return {
		id: String(row['id']),
		runId: String(row['run_id']),
		userId: String(row['user_id']) as OwnerId,
		packageId: String(row['package_id']),
		kodyId: String(row['kody_id']),
		status: String(row['status']),
		beforeCommit:
			row['before_commit'] == null ? null : String(row['before_commit']),
		afterCommit:
			row['after_commit'] == null ? null : String(row['after_commit']),
		changedPaths: parseJsonArray<string>(
			row['changed_paths_json'] == null
				? '[]'
				: String(row['changed_paths_json']),
		),
		findings: parseJsonArray<PackageCodemodFinding>(
			row['findings_json'] == null ? '[]' : String(row['findings_json']),
		),
		checkSummaryJson:
			row['check_summary_json'] == null
				? null
				: String(row['check_summary_json']),
		error: row['error'] == null ? null : String(row['error']),
		revertSnapshotKey:
			row['revert_snapshot_key'] == null
				? null
				: String(row['revert_snapshot_key']),
		ownerDetailJson:
			row['owner_detail_json'] == null
				? null
				: String(row['owner_detail_json']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function createPackageCodemodRun(
	db: D1Database,
	input: {
		id: string
		codemodId: string
		mode: string
		scopeUserId: string | null
		initiatedByUserId: string
		filtersJson?: string
		status?: PackageCodemodRunStatus
		revertOfRunId?: string | null
		createdAt?: string
		updatedAt?: string
	},
): Promise<PackageCodemodRunRecord> {
	const now = new Date().toISOString()
	const createdAt = input.createdAt ?? now
	const updatedAt = input.updatedAt ?? now
	const status = input.status ?? 'running'
	await db
		.prepare(
			`INSERT INTO package_codemod_runs (
				id, codemod_id, mode, scope_user_id, initiated_by_user_id,
				filters_json, status, revert_of_run_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.codemodId,
			input.mode,
			input.scopeUserId,
			input.initiatedByUserId,
			input.filtersJson ?? '{}',
			status,
			input.revertOfRunId ?? null,
			createdAt,
			updatedAt,
		)
		.run()
	return {
		id: input.id,
		codemodId: input.codemodId,
		mode: input.mode,
		scopeUserId: input.scopeUserId,
		initiatedByUserId: input.initiatedByUserId,
		filtersJson: input.filtersJson ?? '{}',
		status,
		revertOfRunId: input.revertOfRunId ?? null,
		createdAt,
		updatedAt,
	}
}

/**
 * Set a run's status. When `expectedStatus` is given the write only applies
 * while the row still has that status, so a read-check-write caller (e.g. the
 * admin stop endpoint) cannot overwrite a concurrent transition. Returns the
 * number of rows changed.
 */
export async function updatePackageCodemodRunStatus(
	db: D1Database,
	input: {
		id: string
		status: PackageCodemodRunStatus
		expectedStatus?: PackageCodemodRunStatus
		updatedAt?: string
	},
): Promise<number> {
	const updatedAt = input.updatedAt ?? new Date().toISOString()
	const statusCondition = input.expectedStatus != null ? ' AND status = ?' : ''
	const params: Array<unknown> = [input.status, updatedAt, input.id]
	if (input.expectedStatus != null) params.push(input.expectedStatus)
	const result = await db
		.prepare(
			`UPDATE package_codemod_runs
			SET status = ?, updated_at = ?
			WHERE id = ?${statusCondition}`,
		)
		.bind(...params)
		.run()
	return result.meta.changes ?? 0
}

/**
 * Mark `running` runs whose heartbeat (`updated_at`) predates the cutoff as
 * `abandoned`. Completion only happens when a caller pages to the end, so
 * runs whose caller stopped paging (closed tab, stopped agent) otherwise sit
 * in `running` forever. Returns the number of runs marked.
 */
export async function markAbandonedPackageCodemodRuns(
	db: D1Database,
	input: {
		updatedBefore: string
		updatedAt?: string
	},
): Promise<number> {
	const updatedAt = input.updatedAt ?? new Date().toISOString()
	const result = await db
		.prepare(
			`UPDATE package_codemod_runs
			SET status = 'abandoned', updated_at = ?
			WHERE status = 'running' AND updated_at < ?`,
		)
		.bind(updatedAt, input.updatedBefore)
		.run()
	return result.meta.changes ?? 0
}

export async function getPackageCodemodRunById(
	db: D1Database,
	runId: string,
	options?: { userId?: string },
): Promise<PackageCodemodRunRecord | null> {
	if (options?.userId != null) {
		const row = await db
			.prepare(
				`SELECT ${runSelectColumns}
				FROM package_codemod_runs
				WHERE id = ? AND scope_user_id = ?`,
			)
			.bind(runId, options.userId)
			.first<Record<string, unknown>>()
		return row ? mapRunRow(row) : null
	}
	const row = await db
		.prepare(
			`SELECT ${runSelectColumns}
			FROM package_codemod_runs
			WHERE id = ?`,
		)
		.bind(runId)
		.first<Record<string, unknown>>()
	return row ? mapRunRow(row) : null
}

export async function listPackageCodemodRuns(
	db: D1Database,
	input: {
		codemodId?: string
		scopeUserId?: string | null
		limit?: number
	} = {},
): Promise<Array<PackageCodemodRunRecord>> {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
	const conditions: Array<string> = []
	const params: Array<unknown> = []
	if (input.codemodId != null) {
		conditions.push('codemod_id = ?')
		params.push(input.codemodId)
	}
	if (input.scopeUserId !== undefined) {
		if (input.scopeUserId == null) {
			conditions.push('scope_user_id IS NULL')
		} else {
			conditions.push('scope_user_id = ?')
			params.push(input.scopeUserId)
		}
	}
	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
	const rows = await db
		.prepare(
			`SELECT ${runSelectColumns}
			FROM package_codemod_runs
			${whereClause}
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(...params, limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapRunRow)
}

export async function insertPackageCodemodRunItem(
	db: D1Database,
	input: {
		id: string
		runId: string
		userId: OwnerId
		packageId: string
		kodyId: string
		status: string
		beforeCommit?: string | null
		afterCommit?: string | null
		changedPaths?: Array<string>
		findings?: Array<PackageCodemodFinding>
		checkSummaryJson?: string | null
		error?: string | null
		revertSnapshotKey?: string | null
		ownerDetailJson?: string | null
		createdAt?: string
		updatedAt?: string
	},
): Promise<PackageCodemodRunItemRecord> {
	const now = new Date().toISOString()
	const createdAt = input.createdAt ?? now
	const updatedAt = input.updatedAt ?? now
	const changedPaths = input.changedPaths ?? []
	const findings = input.findings ?? []
	const changedPathsJson = boundJsonStringArray(changedPaths)
	const findingsJson = boundFindingsJson(findings)
	const checkSummaryJson = boundTextColumn(input.checkSummaryJson ?? null)
	const error = boundTextColumn(input.error ?? null)
	const revertSnapshotKey = input.revertSnapshotKey ?? null
	const ownerDetailJson = boundTextColumn(input.ownerDetailJson ?? null)
	await db
		.prepare(
			`INSERT INTO package_codemod_run_items (
				id, run_id, user_id, package_id, kody_id, status,
				before_commit, after_commit, changed_paths_json, findings_json,
				check_summary_json, error, revert_snapshot_key, owner_detail_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.runId,
			input.userId,
			input.packageId,
			input.kodyId,
			input.status,
			input.beforeCommit ?? null,
			input.afterCommit ?? null,
			changedPathsJson,
			findingsJson,
			checkSummaryJson,
			error,
			revertSnapshotKey,
			ownerDetailJson,
			createdAt,
			updatedAt,
		)
		.run()
	return {
		id: input.id,
		runId: input.runId,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		status: input.status,
		beforeCommit: input.beforeCommit ?? null,
		afterCommit: input.afterCommit ?? null,
		changedPaths: parseJsonArray<string>(changedPathsJson),
		findings: parseJsonArray<PackageCodemodFinding>(findingsJson),
		checkSummaryJson,
		error,
		revertSnapshotKey,
		ownerDetailJson,
		createdAt,
		updatedAt,
	}
}

export async function updatePackageCodemodRunItem(
	db: D1Database,
	input: {
		id: string
		status?: string
		beforeCommit?: string | null
		afterCommit?: string | null
		changedPaths?: Array<string>
		findings?: Array<PackageCodemodFinding>
		checkSummaryJson?: string | null
		error?: string | null
		revertSnapshotKey?: string | null
		updatedAt?: string
	},
) {
	const updates: Array<string> = []
	const params: Array<unknown> = []
	if (input.status !== undefined) {
		updates.push('status = ?')
		params.push(input.status)
	}
	if (input.beforeCommit !== undefined) {
		updates.push('before_commit = ?')
		params.push(input.beforeCommit)
	}
	if (input.afterCommit !== undefined) {
		updates.push('after_commit = ?')
		params.push(input.afterCommit)
	}
	if (input.changedPaths !== undefined) {
		updates.push('changed_paths_json = ?')
		params.push(boundJsonStringArray(input.changedPaths))
	}
	if (input.findings !== undefined) {
		updates.push('findings_json = ?')
		params.push(boundFindingsJson(input.findings))
	}
	if (input.checkSummaryJson !== undefined) {
		updates.push('check_summary_json = ?')
		params.push(boundTextColumn(input.checkSummaryJson))
	}
	if (input.error !== undefined) {
		updates.push('error = ?')
		params.push(boundTextColumn(input.error))
	}
	if (input.revertSnapshotKey !== undefined) {
		updates.push('revert_snapshot_key = ?')
		params.push(input.revertSnapshotKey)
	}
	const updatedAt = input.updatedAt ?? new Date().toISOString()
	updates.push('updated_at = ?')
	params.push(updatedAt)
	if (updates.length === 1) return
	params.push(input.id)
	await db
		.prepare(
			`UPDATE package_codemod_run_items
			SET ${updates.join(', ')}
			WHERE id = ?`,
		)
		.bind(...params)
		.run()
}

export async function listPackageCodemodRunItems(
	db: D1Database,
	input: {
		runId: string
		afterId?: string | null
		limit?: number
		status?: string
		userId?: string
	},
): Promise<Array<PackageCodemodRunItemRecord>> {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
	const conditions = ['run_id = ?', 'id > ?']
	const params: Array<unknown> = [input.runId, input.afterId ?? '']
	if (input.status != null) {
		conditions.push('status = ?')
		params.push(input.status)
	}
	if (input.userId != null) {
		conditions.push('user_id = ?')
		params.push(input.userId)
	}
	const rows = await db
		.prepare(
			`SELECT ${itemSelectColumns}
			FROM package_codemod_run_items
			WHERE ${conditions.join(' AND ')}
			ORDER BY id ASC
			LIMIT ?`,
		)
		.bind(...params, limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapItemRow)
}

export async function hasPackageCodemodRunItemForPackage(
	db: D1Database,
	input: { runId: string; packageId: string },
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM package_codemod_run_items
			WHERE run_id = ? AND package_id = ?
			LIMIT 1`,
		)
		.bind(input.runId, input.packageId)
		.first<{ found: number }>()
	return row != null
}

export async function getPackageCodemodRunItemById(
	db: D1Database,
	itemId: string,
	options?: { userId?: string },
): Promise<PackageCodemodRunItemRecord | null> {
	if (options?.userId != null) {
		const row = await db
			.prepare(
				`SELECT ${itemSelectColumns}
				FROM package_codemod_run_items
				WHERE id = ? AND user_id = ?`,
			)
			.bind(itemId, options.userId)
			.first<Record<string, unknown>>()
		return row ? mapItemRow(row) : null
	}
	const row = await db
		.prepare(
			`SELECT ${itemSelectColumns}
			FROM package_codemod_run_items
			WHERE id = ?`,
		)
		.bind(itemId)
		.first<Record<string, unknown>>()
	return row ? mapItemRow(row) : null
}

/** Exported for unit tests that assert truncation helpers stay under the D1 bound. */
export const packageCodemodLedgerTextBounds = {
	maxRestorableTextColumnBytes,
	maxFindingsStored,
	maxChangedPathsStored,
	boundJsonStringArray,
	boundFindingsJson,
	boundTextColumn,
}

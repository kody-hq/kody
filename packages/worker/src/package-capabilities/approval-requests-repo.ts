import {
	packageApprovalState,
	type PackageApprovalStatus,
} from './package-approval-state.ts'

export type { PackageApprovalStatus } from './package-approval-state.ts'

const resolveGuard = packageApprovalState.guard({
	from: 'pending',
	to: ['approved', 'superseded'],
})

/**
 * The owner approval queue for published packages (`package_approval_requests`).
 * One table and one page serve every reason a publish waits for the owner;
 * each reason owns the shape of its `details`.
 */
export const packageApprovalReasons = [
	'credential_needs_changed',
	'went_public',
] as const

export type PackageApprovalReason = (typeof packageApprovalReasons)[number]

export type PackageApprovalRequest = {
	id: string
	packageId: string
	ownerUserId: string
	reason: PackageApprovalReason
	pendingCommit: string
	baseCommit: string | null
	details: Record<string, unknown>
	status: PackageApprovalStatus
	requestedByUserId: string | null
	resolvedByUserId: string | null
	createdAt: string
	resolvedAt: string | null
}

const columns = `id, package_id, owner_user_id, reason, pending_commit,
	base_commit, details_json, status, requested_by_user_id,
	resolved_by_user_id, created_at, resolved_at`

function readDetails(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string') return {}
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

function readReason(value: unknown): PackageApprovalReason {
	const reason = packageApprovalReasons.find((known) => known === value)
	if (!reason)
		throw new Error(`Unknown package approval reason: ${String(value)}`)
	return reason
}

function mapRow(row: Record<string, unknown>): PackageApprovalRequest {
	const text = (key: string) => (row[key] == null ? null : String(row[key]))
	return {
		id: String(row['id']),
		packageId: String(row['package_id']),
		ownerUserId: String(row['owner_user_id']),
		reason: readReason(row['reason']),
		pendingCommit: String(row['pending_commit']),
		baseCommit: text('base_commit'),
		details: readDetails(row['details_json']),
		status: packageApprovalState.parse(row['status']),
		requestedByUserId: text('requested_by_user_id'),
		resolvedByUserId: text('resolved_by_user_id'),
		createdAt: String(row['created_at']),
		resolvedAt: text('resolved_at'),
	}
}

/**
 * Records a pending request, replacing any pending one for the same package
 * and reason. Asking again for the same commit and base returns the existing
 * request unchanged.
 */
export async function enqueuePackageApprovalRequest(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		reason: PackageApprovalReason
		pendingCommit: string
		baseCommit: string | null
		details: Record<string, unknown>
		requestedByUserId: string | null
		now?: string
	},
): Promise<PackageApprovalRequest> {
	const existing = await getPendingPackageApprovalRequest(db, input)
	if (
		existing &&
		existing.pendingCommit === input.pendingCommit &&
		existing.baseCommit === input.baseCommit
	) {
		return existing
	}
	const now = input.now ?? new Date().toISOString()
	const id = crypto.randomUUID()
	const [, inserted] = await db.batch([
		db
			.prepare(
				`UPDATE package_approval_requests
				SET status = 'superseded', resolved_at = ?
				WHERE package_id = ? AND owner_user_id = ? AND reason = ?
					AND status IN ${resolveGuard}`,
			)
			.bind(now, input.packageId, input.ownerUserId, input.reason),
		db
			.prepare(
				`INSERT OR IGNORE INTO package_approval_requests (
					id, package_id, owner_user_id, reason, pending_commit, base_commit,
					details_json, status, requested_by_user_id, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.bind(
				id,
				input.packageId,
				input.ownerUserId,
				input.reason,
				input.pendingCommit,
				input.baseCommit,
				JSON.stringify(input.details),
				input.requestedByUserId,
				now,
			),
	])
	// A concurrent publish won the one pending slot; its request stands.
	if ((inserted?.meta.changes ?? 0) === 0) {
		const winner = await getPendingPackageApprovalRequest(db, input)
		if (winner) return winner
		throw new Error('Could not record the package approval request.')
	}
	return {
		id,
		packageId: input.packageId,
		ownerUserId: input.ownerUserId,
		reason: input.reason,
		pendingCommit: input.pendingCommit,
		baseCommit: input.baseCommit,
		details: input.details,
		status: 'pending',
		requestedByUserId: input.requestedByUserId,
		resolvedByUserId: null,
		createdAt: now,
		resolvedAt: null,
	}
}

/**
 * Sets or clears one boolean detail flag on a request that is still pending.
 * False when the request was no longer pending.
 */
export async function setPendingPackageApprovalRequestFlag(
	db: D1Database,
	input: { id: string; key: string; value: boolean },
): Promise<boolean> {
	const path = `$.${input.key}`
	const statement = input.value
		? db
				.prepare(
					`UPDATE package_approval_requests
					SET details_json = json_set(coalesce(details_json, '{}'), ?, json('true'))
					WHERE id = ? AND status = 'pending'`,
				)
				.bind(path, input.id)
		: db
				.prepare(
					`UPDATE package_approval_requests
					SET details_json = json_remove(coalesce(details_json, '{}'), ?)
					WHERE id = ? AND status = 'pending'`,
				)
				.bind(path, input.id)
	const result = await statement.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getPendingPackageApprovalRequest(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		reason: PackageApprovalReason
	},
): Promise<PackageApprovalRequest | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE package_id = ? AND owner_user_id = ? AND reason = ?
				AND status = 'pending'
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId, input.reason)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

/** The most recently approved request for one package and reason. */
export async function getLatestApprovedPackageApprovalRequest(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		reason: PackageApprovalReason
	},
): Promise<PackageApprovalRequest | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE package_id = ? AND owner_user_id = ? AND reason = ?
				AND status = 'approved'
			ORDER BY resolved_at DESC, created_at DESC
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId, input.reason)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

export async function listPendingPackageApprovalRequests(
	db: D1Database,
	input: { packageId: string; ownerUserId: string },
): Promise<Array<PackageApprovalRequest>> {
	const { results } = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE package_id = ? AND owner_user_id = ? AND status = 'pending'
			ORDER BY created_at, id`,
		)
		.bind(input.packageId, input.ownerUserId)
		.all<Record<string, unknown>>()
	return results.map(mapRow)
}

/** Every pending request addressed to one owner, oldest first. */
export async function listPendingPackageApprovalRequestsForOwner(
	db: D1Database,
	input: { ownerUserId: string },
): Promise<Array<PackageApprovalRequest>> {
	const { results } = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE owner_user_id = ? AND status = 'pending'
			ORDER BY created_at, id`,
		)
		.bind(input.ownerUserId)
		.all<Record<string, unknown>>()
	return results.map(mapRow)
}

/** One request addressed to an owner, whatever package it is for. */
export async function getPackageApprovalRequestForOwner(
	db: D1Database,
	input: { id: string; ownerUserId: string },
): Promise<PackageApprovalRequest | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE id = ? AND owner_user_id = ?
			LIMIT 1`,
		)
		.bind(input.id, input.ownerUserId)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

export async function getPackageApprovalRequest(
	db: D1Database,
	input: { id: string; packageId: string; ownerUserId: string },
): Promise<PackageApprovalRequest | null> {
	const row = await db
		.prepare(
			`SELECT ${columns} FROM package_approval_requests
			WHERE id = ? AND package_id = ? AND owner_user_id = ?
			LIMIT 1`,
		)
		.bind(input.id, input.packageId, input.ownerUserId)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

/** Resolves a pending request; false when it was no longer pending. */
export async function resolvePackageApprovalRequest(
	db: D1Database,
	input: {
		id: string
		status: Exclude<PackageApprovalStatus, 'pending'>
		resolvedByUserId: string | null
		now?: string
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE package_approval_requests
			SET status = ?, resolved_by_user_id = ?, resolved_at = ?
			WHERE id = ? AND status IN ${resolveGuard}`,
		)
		.bind(
			input.status,
			input.resolvedByUserId,
			input.now ?? new Date().toISOString(),
			input.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Workflow run projections stored in the per-user RunLog Durable Object.
 *
 * Per-user RunLog `workflow_projections` rows (DO identity is the user; no
 * `user_id` column) plus the Cloudflare Workflow binding name so a user with
 * multiple bindings can be projected correctly. This is correctness state for
 * idempotency and concurrent-workflow entitlements; it must never be derived
 * from pruned run-history rows.
 */

import {
	activeWorkflowStatusValues,
	type WorkflowRunStatus,
} from '#worker/package-runtime/workflow-statuses.ts'

/**
 * Cloudflare Workflow binding names Kody may project. Expand the union when a
 * second binding ships; resolvers must stay exhaustive.
 */
export const workflowBindingNames = ['DYNAMIC_CALLABLE_WORKFLOWS'] as const

export type WorkflowBindingName = (typeof workflowBindingNames)[number]

export function isWorkflowBindingName(
	value: string,
): value is WorkflowBindingName {
	return (workflowBindingNames as ReadonlyArray<string>).includes(value)
}

export type WorkflowProjectionSourceType = 'package' | 'inline'

/**
 * How a package workflow resolves its source on each attempt.
 *
 * - `latest`: every attempt runs the package's published revision at the time
 *   that attempt starts (the default, and the behavior of workflows queued
 *   before this field existed).
 * - `pinned`: every attempt must run the commit resolved at enqueue; an
 *   attempt refuses to run when the package was republished since.
 */
export const workflowSourceRevisionPolicies = ['latest', 'pinned'] as const

export type WorkflowSourceRevisionPolicy =
	(typeof workflowSourceRevisionPolicies)[number]

export function parseWorkflowProjectionSourceRevision(
	value: unknown,
): WorkflowSourceRevisionPolicy | null {
	return value === 'latest' || value === 'pinned' ? value : null
}

export type WorkflowProjectionRecord = {
	id: string
	bindingName: string
	sourceType: WorkflowProjectionSourceType
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: string | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
	/** Package workflows: published commit resolved at enqueue (null before v14). */
	enqueuedCommit: string | null
	sourceRevision: WorkflowSourceRevisionPolicy | null
}

export type WorkflowProjectionUpsertInput = {
	id: string
	bindingName: string
	sourceType: WorkflowProjectionSourceType
	packageId?: string | null
	kodyId?: string | null
	sourceId?: string | null
	workflowName: string
	exportName?: string | null
	idempotencyKey: string
	runAt: string
	planDate?: string | null
	status?: string | null
	createdAt?: string | null
	updatedAt?: string | null
	completedAt?: string | null
	lastError?: string | null
	/** Insert-only: later status upserts never change it. */
	enqueuedCommit?: string | null
	/** Insert-only: later status upserts never change it. */
	sourceRevision?: WorkflowSourceRevisionPolicy | null
}

export type WorkflowProjectionReserveResult = {
	/**
	 * Active + creating count excluding this id so an idempotent re-reserve of
	 * the same workflow does not consume two entitlement slots.
	 */
	countBeforeReservation: number
	/** True when this id holds a `creating` reservation after the call. */
	reserved: boolean
	/** True when a new `creating` row was inserted by this call. */
	inserted: boolean
	projection: WorkflowProjectionRecord
}

/** Mid-creation placeholder excluded from non-creating idempotency lookups. */
export const creatingWorkflowProjectionStatus = 'creating'

/**
 * Stale `creating` reservations older than this are pruned before reserve/count
 * and by retention alarms. Active/running projections are never TTL-pruned.
 */
export const workflowProjectionCreatingTtlMs = 10 * 60 * 1000

export const workflowProjectionActiveStatuses: ReadonlyArray<string> =
	activeWorkflowStatusValues

/** Statuses that occupy a concurrent-workflow entitlement slot. */
export const workflowProjectionReservationStatuses: ReadonlyArray<string> = [
	...workflowProjectionActiveStatuses,
	creatingWorkflowProjectionStatus,
]

export type { WorkflowRunStatus }

/**
 * Keyset cursor for `workflow_projections` pages (newest first by
 * `created_at`, then `id`). Same encoding as the RunLog runs cursor, so
 * cursors minted before this helper existed still decode.
 */
export function encodeWorkflowProjectionCursor(position: {
	createdAt: string
	id: string
}) {
	return btoa(
		JSON.stringify({ startedAt: position.createdAt, id: position.id }),
	)
}

export function decodeWorkflowProjectionCursor(
	cursor: string,
): { createdAt: string; id: string } | null {
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const createdAt = record['startedAt']
		const id = record['id']
		if (typeof createdAt !== 'string' || typeof id !== 'string') return null
		return { createdAt, id }
	} catch {
		return null
	}
}

/** True when `row` sorts strictly after the cursor position (older page). */
export function isAfterWorkflowProjectionCursor(
	row: { createdAt: string; id: string },
	cursor: { createdAt: string; id: string },
) {
	if (row.createdAt !== cursor.createdAt)
		return row.createdAt < cursor.createdAt
	return row.id < cursor.id
}

const publishWorkflowName = 'packagePublishExternalPush'

/**
 * Read-only recovery of package id and target commit from a durable publish
 * idempotency key, for backfilling rows queued before provenance columns were
 * filled. Keys are `<owner>:packagePublishExternalPush:[v2:]<canonical JSON>`;
 * released keys (`released:<id>`) carry nothing and return null. This never
 * builds or matches keys.
 */
export function publishProvenanceFromIdempotencyKey(
	key: string,
): { packageId: string; commit: string } | null {
	const marker = `:${publishWorkflowName}:`
	const markerIndex = key.indexOf(marker)
	if (markerIndex <= 0) return null
	let rest = key.slice(markerIndex + marker.length)
	if (rest.startsWith('v2:')) rest = rest.slice('v2:'.length)
	try {
		const parsed = JSON.parse(rest) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const packageId = record['packageId']
		const commit = record['newCommit']
		if (typeof packageId !== 'string' || !packageId.trim()) return null
		if (typeof commit !== 'string' || !commit.trim()) return null
		return { packageId: packageId.trim(), commit: commit.trim() }
	} catch {
		return null
	}
}

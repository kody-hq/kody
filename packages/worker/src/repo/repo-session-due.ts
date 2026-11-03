import type { RepoSessionRow } from './types.ts'

/**
 * Read-only leftovers (never checkpointed) are cheap to lose — there is no
 * unpublished work — so they sweep after a short idle window. Checkpointed
 * sessions use the generous window because unpublished work in a swept session
 * is unrecoverable. Every session operation bumps `updated_at`, so both windows
 * are idle time, not age.
 */
export const unusedAbandonedSessionRetentionMs = 30 * 60 * 1000
export const editedAbandonedSessionRetentionMs = 7 * 24 * 60 * 60 * 1000

/** Far-future due used so every catalog owner stays pageable for storage backfill. */
export const repoSessionFarFutureDueAt = '2099-01-01T00:00:00.000Z'

export type RepoSessionDueFields = Pick<
	RepoSessionRow,
	'status' | 'last_checkpoint_at' | 'updated_at' | 'expires_at'
>

export function unusedActiveDueBefore(now: Date): string {
	return new Date(
		now.valueOf() - unusedAbandonedSessionRetentionMs,
	).toISOString()
}

export function editedActiveDueBefore(now: Date): string {
	return new Date(
		now.valueOf() - editedAbandonedSessionRetentionMs,
	).toISOString()
}

function addMs(iso: string, ms: number): string {
	return new Date(Date.parse(iso) + ms).toISOString()
}

export function nextRepoSessionDueAt(row: RepoSessionDueFields): string | null {
	if (row.status === 'active' && row.last_checkpoint_at == null) {
		return addMs(row.updated_at, unusedAbandonedSessionRetentionMs)
	}
	if (row.status === 'active' && row.last_checkpoint_at != null) {
		return addMs(row.updated_at, editedAbandonedSessionRetentionMs)
	}
	if (
		(row.status === 'published' || row.status === 'discarded') &&
		row.expires_at != null
	) {
		return row.expires_at
	}
	return null
}

export function nextOwnerDueAt(
	rows: ReadonlyArray<RepoSessionDueFields>,
): string | null {
	if (rows.length === 0) return null
	const dues = rows
		.map((row) => nextRepoSessionDueAt(row))
		.filter((due): due is string => due != null)
	if (dues.length === 0) return repoSessionFarFutureDueAt
	return dues.reduce((earliest, due) => (due < earliest ? due : earliest))
}

export function isRepoSessionDue(
	row: RepoSessionDueFields,
	now: Date,
): boolean {
	const dueAt = nextRepoSessionDueAt(row)
	return dueAt != null && dueAt <= now.toISOString()
}

export function repoSessionCleanupReason(
	status: RepoSessionRow['status'],
): 'abandoned' | 'expired' {
	return status === 'active' ? 'abandoned' : 'expired'
}

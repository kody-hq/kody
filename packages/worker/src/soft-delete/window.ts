export const softDeleteRetentionDays = 30

export function softDeletePurgeCutoffIso(now: Date = new Date()): string {
	const cutoff = new Date(now.getTime())
	cutoff.setUTCDate(cutoff.getUTCDate() - softDeleteRetentionDays)
	return cutoff.toISOString()
}

/** When a row soft-deleted at `deletedAt` stops being restorable. */
export function softDeleteRestoreDeadlineIso(deletedAt: string) {
	const deadline = new Date(deletedAt)
	if (Number.isNaN(deadline.getTime())) return null
	deadline.setUTCDate(deadline.getUTCDate() + softDeleteRetentionDays)
	return deadline.toISOString()
}

export function isWithinSoftDeleteRestoreWindow(
	deletedAt: string,
	now: Date = new Date(),
): boolean {
	const deletedMs = Date.parse(deletedAt)
	if (Number.isNaN(deletedMs)) return false
	const cutoffMs = Date.parse(softDeletePurgeCutoffIso(now))
	return deletedMs >= cutoffMs
}

import {
	publishPhaseTimingFields,
	type PublishPhaseTimings,
} from '#worker/repo/publish-phase-timing.ts'

/**
 * What a durable `packagePublishExternalPush` run keeps as `metadata.result`.
 * Fixed-size (commit ids, a flag, and a few numbers) so the 4 KiB run result
 * snapshot never truncates it. The full answer (manifest, static dependents,
 * hints) is not stored; read it from `packageGet` instead.
 */
export type DurablePublishRunResult = {
	status: string | null
	previous_commit: string | null
	published_commit: string | null
	enqueued_commit: string | null
	checks_rerun: boolean
	phase_timings: PublishPhaseTimings
}

function readCommit(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPhaseTimings(value: unknown): PublishPhaseTimings {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const record = value as Record<string, unknown>
	const timings: PublishPhaseTimings = {}
	for (const field of publishPhaseTimingFields) {
		const ms = record[field]
		if (typeof ms === 'number' && Number.isFinite(ms)) timings[field] = ms
	}
	return timings
}

export function compactDurablePublishResult(
	value: unknown,
	enqueuedCommit: string | null,
): DurablePublishRunResult {
	const record =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	const status = record['status']
	return {
		status: typeof status === 'string' ? status : null,
		previous_commit: readCommit(record, 'previous_commit'),
		published_commit: readCommit(record, 'published_commit'),
		enqueued_commit: enqueuedCommit?.trim() || null,
		checks_rerun: record['checks_rerun'] === true,
		phase_timings: readPhaseTimings(record['phase_timings']),
	}
}

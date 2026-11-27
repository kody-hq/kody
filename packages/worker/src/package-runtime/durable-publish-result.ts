import {
	publishPhaseTimingFields,
	type PublishPhaseTimings,
} from '#worker/repo/publish-phase-timing.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'

/**
 * Statuses whose commit is live. `held_for_approval` is not one: its commit
 * is built but serves nobody until the owner approves it.
 */
const publishedExternalPushStatuses = ['published', 'already_published']

/**
 * The module a durable `packagePublishExternalPush` run executes. The engine
 * stores what it returns, then fails the run when it did not publish (see
 * {@link durablePublishRefusalReason}).
 */
export const durablePublishWorkflowCode = `import { kody } from 'kody:runtime'
export default async function main(params = {}) {
	return await kody.packagePublishExternalPush(params)
}`

/**
 * Why a durable publish run that did not publish fails, or null when it
 * published. Such a run fails once (no step retries) with this as last_error,
 * so it is not recorded as a success and its idempotency key is released for
 * the next attempt. The full refusal stays readable with packageRunResult.
 */
export function durablePublishRefusalReason(value: unknown): string | null {
	const result =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	const status = typeof result['status'] === 'string' ? result['status'] : null
	if (status !== null && publishedExternalPushStatuses.includes(status)) {
		return null
	}
	const failedChecks = Array.isArray(result['failed_checks'])
		? result['failed_checks']
				.filter(
					(check): check is Record<string, unknown> =>
						Boolean(check) && typeof check === 'object' && check.ok === false,
				)
				.map(
					(check) =>
						`${String(check['kind'])}: ${String(check['message'] ?? '').slice(0, 600)}`,
				)
				.join('; ')
		: ''
	const detail = failedChecks || String(result['message'] ?? '').slice(0, 1200)
	return `packagePublishExternalPush returned ${String(status)}${detail ? `: ${detail}` : ''}`
}

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

/**
 * Only the durable publish dispatch runs this exact module; the workflow name
 * alone is caller-supplied, so a custom inline workflow that reuses it keeps
 * its own result.
 */
export function isDurablePublishWorkflowCode(code: string) {
	return code === durablePublishWorkflowCode
}

export async function describeDurablePublishState(input: {
	env: Env
	userId: OwnerId
	sourceId?: string | null
	commit?: string | null
}) {
	const { env, userId, sourceId, commit } = input
	let applied = 'unknown'
	let jobPins = 'unknown'
	if (sourceId && commit) {
		const [source, jobs] = await Promise.allSettled([
			Promise.resolve().then(() =>
				getEntitySourceByIdForUser(env.APP_DB, { id: sourceId, userId }),
			),
			Promise.resolve().then(() => jobsData(env).listJobsForUser({ userId })),
		])
		if (source.status === 'fulfilled' && source.value) {
			const row = source.value
			applied =
				row.serving_commit === commit
					? 'yes, commit is serving'
					: row.published_commit === commit
						? row.held_commit === commit
							? 'recorded, held for approval'
							: 'recorded, not serving'
						: 'commit is not current'
		}
		if (jobs.status === 'fulfilled') {
			const pins = jobs.value.filter((job) => job.source_id === sourceId)
			const matching = pins.filter((job) => job.published_commit === commit)
			jobPins = pins.length
				? `${matching.length} of ${pins.length} existing jobs pinned to this commit`
				: 'no existing package jobs'
		}
	}
	return `Publish applied: ${applied}. Job rebind: ${jobPins}.`
}

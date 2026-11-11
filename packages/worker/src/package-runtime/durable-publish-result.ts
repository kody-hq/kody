import {
	publishPhaseTimingFields,
	type PublishPhaseTimings,
} from '#worker/repo/publish-phase-timing.ts'
import { terminalInlineWorkflowErrorPrefix } from './workflow-statuses.ts'

const publishedExternalPushStatuses = ['published', 'already_published']

/**
 * The module a durable `packagePublishExternalPush` run executes. A publish
 * that did not publish fails its run once (no step retries) with the reason as
 * last_error, so the run is not recorded as a success and its idempotency key
 * is released for the next attempt.
 */
export const durablePublishWorkflowCode = `import { kody } from 'kody:runtime'
const publishedStatuses = ${JSON.stringify(publishedExternalPushStatuses)}
export default async function main(params = {}) {
	const result = await kody.packagePublishExternalPush(params)
	const status = result && typeof result === 'object' ? result.status : null
	if (publishedStatuses.includes(status)) return result
	const failedChecks = Array.isArray(result?.failed_checks)
		? result.failed_checks
				.filter((check) => check && check.ok === false)
				.map((check) => String(check.kind) + ': ' + String(check.message ?? '').slice(0, 600))
				.join('; ')
		: ''
	const detail = failedChecks || String(result?.message ?? '').slice(0, 1200)
	throw new Error(
		${JSON.stringify(terminalInlineWorkflowErrorPrefix)} +
			'packagePublishExternalPush returned ' + String(status) + (detail ? ': ' + detail : ''),
	)
}`

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

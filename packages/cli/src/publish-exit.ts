/**
 * Exit codes for `kody package publish` — npm-like: success (0) only for a
 * completed publish or true no-op tip; refusals/rejections exit 1.
 *
 * Statuses come from `packagePublishExternalPush` /
 * `RepoExternalPublishResult` (worker repo types + publish-external-push).
 */

/** Terminal success: tip advanced or true no-op (incl. artifacts_rebuilt). */
export const publishCliSuccessStatuses = [
	'published',
	'already_published',
] as const

/**
 * Async handoff is not a refusal — the durable run is accepted. Poll
 * workflowRunList for the terminal publish status.
 */
export const publishCliAcceptedStatuses = ['dispatched'] as const

/** Refusal / rejection bodies that still arrive as HTTP 2xx with a status. */
export const publishCliRefusalStatuses = [
	'not_fast_forward',
	'checks_failed',
	'locked',
	'approval_required',
] as const

export type PublishCliSuccessStatus = (typeof publishCliSuccessStatuses)[number]
export type PublishCliAcceptedStatus =
	(typeof publishCliAcceptedStatuses)[number]
export type PublishCliRefusalStatus = (typeof publishCliRefusalStatuses)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readPublishStatus(result: unknown): string | null {
	if (!isRecord(result)) return null
	return typeof result.status === 'string' ? result.status : null
}

export function isPublishCliSuccessStatus(
	status: string | null,
): status is PublishCliSuccessStatus | PublishCliAcceptedStatus {
	return (
		status === 'published' ||
		status === 'already_published' ||
		status === 'dispatched'
	)
}

/** Exit 0 for published / already_published / dispatched; else 1. */
export function publishCliExitCode(result: unknown): 0 | 1 {
	return isPublishCliSuccessStatus(readPublishStatus(result)) ? 0 : 1
}

function failedCheckMessages(result: Record<string, unknown>): Array<string> {
	const failed = result.failed_checks
	if (!Array.isArray(failed)) return []
	const messages: Array<string> = []
	for (const check of failed) {
		if (!isRecord(check)) continue
		const kind = typeof check.kind === 'string' ? check.kind : 'check'
		const message =
			typeof check.message === 'string' && check.message.trim()
				? check.message.trim()
				: null
		messages.push(message ? `${kind}: ${message}` : kind)
	}
	return messages
}

/**
 * Human error line(s) for stderr on refusal. Prefer the API `message` when
 * present; for `checks_failed`, summarize failed_checks.
 */
export function publishRefusalMessage(result: unknown): string {
	const status = readPublishStatus(result)
	if (status === null) {
		return 'Publish refused: response had no status.'
	}
	if (isRecord(result) && typeof result.message === 'string') {
		const trimmed = result.message.trim()
		if (trimmed) return trimmed
	}
	if (status === 'checks_failed' && isRecord(result)) {
		const details = failedCheckMessages(result)
		if (details.length > 0) {
			return `Publish checks failed.\n${details.map((line) => `- ${line}`).join('\n')}`
		}
		return 'Publish checks failed.'
	}
	return `Publish refused (${status}).`
}

import { errorCauseChainIncludes, getErrorMessage } from './error-message.ts'

/**
 * Cloudflare Workers hang detection (formerly "The script will never generate
 * a response"). Fired when the runtime sees an unresolved Promise with no
 * remaining I/O or useful progress — for example a dynamic worker awaiting a
 * Promise that never settles. Exact platform copy includes a docs link; match
 * the stable hung clause so wrappers and truncated forms still classify.
 *
 * @see https://developers.cloudflare.com/workers/observability/errors/
 */
export const workersHungRequestCanceledMessageFragment =
	'had hung and would never generate a response'

/**
 * Owner-facing message when dynamic-worker evaluate is canceled as hung.
 * Shared by MCP execute and other surfaces; do not mention scheduled jobs.
 */
export const workersHungExecutionMessage =
	'Execution hung without making progress and was stopped. Check for an await that never settles (for example a Promise with no resolver, or a stuck RPC).'

/**
 * Job-owner facing message when a scheduled occurrence is stopped because the
 * Workers runtime canceled a hung request. Distinct from the bare platform
 * string and from {@link workersHungExecutionMessage} so Activity / jobGet
 * name the scheduler path instead of Cloudflare internals.
 */
export const scheduledJobHungExecutionMessage =
	'Scheduled job execution hung without making progress and was stopped so the scheduler could continue. Check the job for an await that never settles (for example a Promise with no resolver, or a stuck RPC).'

export function isWorkersHungRequestCanceledMessage(message: string) {
	return message.includes(workersHungRequestCanceledMessageFragment)
}

export function isWorkersHungRequestCanceledError(error: unknown) {
	if (typeof error === 'string') {
		return isWorkersHungRequestCanceledMessage(error)
	}
	return errorCauseChainIncludes(error, isWorkersHungRequestCanceledMessage)
}

export function workersHungRequestErrorMessage(error: unknown) {
	return getErrorMessage(error)
}

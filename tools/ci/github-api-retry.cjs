'use strict'

/**
 * Bounded retries for transient GitHub API 5xx responses in preview workflow
 * github-script steps. Kept as CommonJS so `actions/github-script` can
 * `require` it without a TypeScript loader.
 */

const defaultMaxAttempts = 4
const defaultBaseDelayMs = 1_000

function isRetryableGithubApiStatus(status) {
	return Number.isInteger(status) && status >= 500 && status < 600
}

function githubApiErrorStatus(error) {
	if (error == null || typeof error !== 'object') return undefined
	if (typeof error.status === 'number') return error.status
	const response = error.response
	if (
		response != null &&
		typeof response === 'object' &&
		typeof response.status === 'number'
	) {
		return response.status
	}
	return undefined
}

function isRetryableGithubApiError(error) {
	const status = githubApiErrorStatus(error)
	return status !== undefined && isRetryableGithubApiStatus(status)
}

/**
 * @template T
 * @param {() => Promise<T>} run
 * @param {{
 *   maxAttempts?: number
 *   baseDelayMs?: number
 *   sleep?: (ms: number) => Promise<void>
 *   isRetryable?: (error: unknown) => boolean
 *   onRetry?: (input: {
 *     attempt: number
 *     maxAttempts: number
 *     delayMs: number
 *     error: unknown
 *   }) => void
 * }} [options]
 * @returns {Promise<T>}
 */
async function withGithubApiRetry(run, options = {}) {
	const maxAttempts = options.maxAttempts ?? defaultMaxAttempts
	const baseDelayMs = options.baseDelayMs ?? defaultBaseDelayMs
	const sleep =
		options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
	const isRetryable = options.isRetryable ?? isRetryableGithubApiError
	const onRetry = options.onRetry

	/** @type {unknown} */
	let lastError
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await run()
		} catch (error) {
			lastError = error
			if (attempt === maxAttempts || !isRetryable(error)) {
				throw error
			}
			const delayMs = baseDelayMs * 2 ** (attempt - 1)
			onRetry?.({ attempt, maxAttempts, delayMs, error })
			await sleep(delayMs)
		}
	}
	throw lastError
}

module.exports = {
	defaultMaxAttempts,
	defaultBaseDelayMs,
	isRetryableGithubApiStatus,
	githubApiErrorStatus,
	isRetryableGithubApiError,
	withGithubApiRetry,
}

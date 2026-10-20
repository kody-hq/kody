import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
	defaultBaseDelayMs,
	defaultMaxAttempts,
	githubApiErrorStatus,
	isRetryableGithubApiError,
	isRetryableGithubApiStatus,
	withGithubApiRetry,
} = require(
	join(dirname(fileURLToPath(import.meta.url)), 'github-api-retry.cjs'),
) as {
	defaultBaseDelayMs: number
	defaultMaxAttempts: number
	githubApiErrorStatus: (error: unknown) => number | undefined
	isRetryableGithubApiError: (error: unknown) => boolean
	isRetryableGithubApiStatus: (status: number) => boolean
	withGithubApiRetry: <T>(
		run: () => Promise<T>,
		options?: {
			maxAttempts?: number
			baseDelayMs?: number
			sleep?: (ms: number) => Promise<void>
			isRetryable?: (error: unknown) => boolean
			onRetry?: (input: {
				attempt: number
				maxAttempts: number
				delayMs: number
				error: unknown
			}) => void
		},
	) => Promise<T>
}

function httpError(status: number, message = 'Server Error') {
	const error = new Error(message) as Error & {
		status: number
		response: { status: number }
	}
	error.name = 'HttpError'
	error.status = status
	error.response = { status }
	return error
}

test('isRetryableGithubApiStatus accepts only 5xx', () => {
	expect(isRetryableGithubApiStatus(500)).toBe(true)
	expect(isRetryableGithubApiStatus(502)).toBe(true)
	expect(isRetryableGithubApiStatus(503)).toBe(true)
	expect(isRetryableGithubApiStatus(504)).toBe(true)
	expect(isRetryableGithubApiStatus(599)).toBe(true)
	expect(isRetryableGithubApiStatus(400)).toBe(false)
	expect(isRetryableGithubApiStatus(401)).toBe(false)
	expect(isRetryableGithubApiStatus(403)).toBe(false)
	expect(isRetryableGithubApiStatus(404)).toBe(false)
	expect(isRetryableGithubApiStatus(429)).toBe(false)
	expect(isRetryableGithubApiStatus(200)).toBe(false)
})

test('isRetryableGithubApiError reads Octokit status and response.status', () => {
	expect(isRetryableGithubApiError(httpError(502))).toBe(true)
	expect(isRetryableGithubApiError(httpError(404))).toBe(false)
	expect(isRetryableGithubApiError(new Error('no status'))).toBe(false)
	expect(isRetryableGithubApiError({ response: { status: 503 } })).toBe(true)
	expect(githubApiErrorStatus(httpError(502))).toBe(502)
	expect(githubApiErrorStatus(null)).toBeUndefined()
})

test('withGithubApiRetry retries 5xx with exponential backoff then succeeds', async () => {
	const sleeps: Array<number> = []
	const retries: Array<number> = []
	let attempts = 0
	const result = await withGithubApiRetry(
		async () => {
			attempts += 1
			if (attempts < 3) throw httpError(502)
			return 'ok'
		},
		{
			baseDelayMs: 10,
			sleep: async (ms) => {
				sleeps.push(ms)
			},
			onRetry: ({ attempt }) => {
				retries.push(attempt)
			},
		},
	)
	expect(result).toBe('ok')
	expect(attempts).toBe(3)
	expect(retries).toEqual([1, 2])
	expect(sleeps).toEqual([10, 20])
})

test('withGithubApiRetry does not retry 4xx and surfaces the error', async () => {
	let attempts = 0
	await expect(
		withGithubApiRetry(async () => {
			attempts += 1
			throw httpError(403, 'Forbidden')
		}),
	).rejects.toMatchObject({ status: 403 })
	expect(attempts).toBe(1)
})

test('withGithubApiRetry exhausts attempts on persistent 5xx', async () => {
	let attempts = 0
	await expect(
		withGithubApiRetry(
			async () => {
				attempts += 1
				throw httpError(504)
			},
			{ maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
		),
	).rejects.toMatchObject({ status: 504 })
	expect(attempts).toBe(3)
})

test('defaults match the preview workflow budget', () => {
	expect(defaultMaxAttempts).toBe(4)
	expect(defaultBaseDelayMs).toBe(1_000)
})

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
	githubApiErrorStatus,
	isRetryableGithubApiError,
	isRetryableGithubNetworkError,
	withGithubApiRetry,
} = require(
	join(dirname(fileURLToPath(import.meta.url)), 'github-api-retry.cjs'),
) as {
	githubApiErrorStatus: (error: unknown) => number | undefined
	isRetryableGithubApiError: (error: unknown) => boolean
	isRetryableGithubNetworkError: (error: unknown) => boolean
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

test('isRetryableGithubApiError reads Octokit status and response.status', () => {
	expect(isRetryableGithubApiError(httpError(502))).toBe(true)
	expect(isRetryableGithubApiError(httpError(404))).toBe(false)
	expect(isRetryableGithubApiError(new Error('no status'))).toBe(false)
	expect(isRetryableGithubApiError({ response: { status: 503 } })).toBe(true)
	expect(githubApiErrorStatus(httpError(502))).toBe(502)
	expect(githubApiErrorStatus(null)).toBeUndefined()
})

test('isRetryableGithubApiError treats transport failures without status as retryable', () => {
	const reset = new Error(
		'upstream connect error or disconnect/reset before headers',
	) as Error & { code?: string }
	reset.code = 'ECONNRESET'
	expect(isRetryableGithubNetworkError(reset)).toBe(true)
	expect(isRetryableGithubApiError(reset)).toBe(true)
	expect(
		isRetryableGithubApiError(
			new Error(
				'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: connection termination',
			),
		),
	).toBe(true)
	expect(isRetryableGithubApiError(new Error('permission denied'))).toBe(false)
	expect(isRetryableGithubApiError(httpError(403, 'Forbidden'))).toBe(false)
})

test('CLA record soft-exit path: exhausted 5xx stays retryable; 403 does not', async () => {
	await expect(
		withGithubApiRetry(
			async () => {
				throw httpError(
					503,
					'upstream connect error or disconnect/reset before headers',
				)
			},
			{ maxAttempts: 5, baseDelayMs: 8_000, sleep: async () => {} },
		),
	).rejects.toMatchObject({ status: 503 })

	let forbiddenAttempts = 0
	await expect(
		withGithubApiRetry(async () => {
			forbiddenAttempts += 1
			throw httpError(403, 'Resource not accessible by integration')
		}),
	).rejects.toMatchObject({ status: 403 })
	expect(forbiddenAttempts).toBe(1)
	expect(
		isRetryableGithubApiError(
			httpError(
				503,
				'upstream connect error or disconnect/reset before headers',
			),
		),
	).toBe(true)
	expect(
		isRetryableGithubApiError(
			httpError(403, 'Resource not accessible by integration'),
		),
	).toBe(false)
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

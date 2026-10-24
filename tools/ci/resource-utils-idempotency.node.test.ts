import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	deleteArtifactsNamespace,
	ensureArtifactsNamespace,
	ensureD1Database,
	ensureR2Bucket,
	type runWrangler,
} from './resource-utils.ts'

const creds = { accountId: 'account-1', apiToken: 'token-1', dryRun: false }
const ok = (result: unknown) => Response.json({ success: true, result })
const mockFetch = (...responses: Array<Response>) => {
	const fetcher = vi.fn<typeof fetch>()
	for (const response of responses) fetcher.mockResolvedValueOnce(response)
	return fetcher
}

test('ensureD1Database retries transient creates and reconciles already-existing databases', async () => {
	consoleError.mockImplementation(() => {})
	const list = vi
		.fn<() => Array<{ uuid: string; name: string }>>()
		.mockReturnValueOnce([])
		.mockReturnValueOnce([])
		.mockReturnValueOnce([])
		.mockReturnValueOnce([{ uuid: 'database-uuid', name: 'kody-audit' }])
	const run = vi
		.fn<typeof runWrangler>()
		.mockReturnValueOnce({
			status: 1,
			stdout: '',
			stderr:
				'internal error; reference = e_61GNS0_bc1361e65fb4404f972d6735a9a3e4b4 [code: 7500]',
			errorMessage: '',
		})
		.mockReturnValueOnce({
			status: 1,
			stdout: '',
			stderr: 'A database with that name already exists',
			errorMessage: '',
		})
	const delays: Array<number> = []
	await expect(
		ensureD1Database({
			name: 'kody-audit',
			dryRun: false,
			list,
			run,
			maxAttempts: 3,
			sleep: async (ms) => {
				delays.push(ms)
			},
		}),
	).resolves.toEqual({ name: 'kody-audit', id: 'database-uuid' })
	expect(run).toHaveBeenCalledTimes(2)
	expect(list).toHaveBeenCalledTimes(4)
	expect(delays).toEqual([250, 1_000, 1_000])
})

test('ensureD1Database never guesses an ID when an existing database is not listed', async () => {
	consoleError.mockImplementation(() => {})
	const list = vi
		.fn<() => Array<{ uuid: string; name: string }>>()
		.mockReturnValue([])
	const run = vi.fn<typeof runWrangler>().mockReturnValue({
		status: 1,
		stdout: '',
		stderr: 'A database with that name already exists',
		errorMessage: '',
	})
	await expect(
		ensureD1Database({
			name: 'kody-audit',
			dryRun: false,
			list,
			run,
			maxAttempts: 1,
			sleep: async () => {},
		}),
	).rejects.toThrow(
		'D1 database "kody-audit" already exists but could not be found via list after 3 attempts',
	)
	expect(list).toHaveBeenCalledTimes(4)
})

test('ensureR2Bucket retries Cloudflare API flakes and accepts an already-created bucket', async () => {
	consoleError.mockImplementation(() => {})
	const run = vi
		.fn<typeof runWrangler>()
		.mockReturnValueOnce({
			status: 1,
			stdout: '',
			stderr:
				'A request to the Cloudflare API (/accounts/acct/r2/buckets) failed. [code: 10001]',
			errorMessage: '',
		})
		.mockReturnValueOnce({
			status: 1,
			stdout: '',
			stderr: 'The bucket you tried to create already exists, and you own it.',
			errorMessage: '',
		})
	const delays: Array<number> = []
	await expect(
		ensureR2Bucket({
			name: 'kody-email-blobs',
			dryRun: false,
			run,
			sleep: async (ms) => {
				delays.push(ms)
			},
			maxAttempts: 3,
		}),
	).resolves.toEqual({ name: 'kody-email-blobs' })
	expect(run).toHaveBeenCalledTimes(2)
	expect(delays).toEqual([250])
})

function namespaceNotFound() {
	return Response.json(
		{
			success: false,
			result: null,
			errors: [{ code: 1000, message: 'namespace not found' }],
		},
		{ status: 404 },
	)
}

function activationInProgress() {
	return Response.json(
		{
			success: false,
			errors: [
				{
					code: 1000,
					message: 'Namespace activation is already in progress',
				},
			],
		},
		{ status: 409 },
	)
}

test('ensureArtifactsNamespace waits for an activating namespace to become visible', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = mockFetch(
		namespaceNotFound(),
		activationInProgress(),
		namespaceNotFound(),
		ok({ namespace: 'kody-pr-42' }),
	)
	let now = 0
	const delays: Array<number> = []
	await expect(
		ensureArtifactsNamespace({
			...creds,
			namespace: 'kody-pr-42',
			fetcher,
			activationWaitDeadlineMs: 10_000,
			activationPollIntervalMs: 5_000,
			now: () => now,
			sleep: async (ms) => {
				delays.push(ms)
				now += ms
			},
		}),
	).resolves.toEqual({ namespace: 'kody-pr-42' })
	expect(fetcher).toHaveBeenCalledTimes(4)
	expect(delays).toEqual([5_000])
})

test('ensureArtifactsNamespace fails clearly when activation never completes', async () => {
	const fetcher = mockFetch(
		namespaceNotFound(),
		activationInProgress(),
		namespaceNotFound(),
		namespaceNotFound(),
		namespaceNotFound(),
	)
	let now = 0
	await expect(
		ensureArtifactsNamespace({
			...creds,
			namespace: 'kody-pr-42',
			fetcher,
			activationWaitDeadlineMs: 10,
			activationPollIntervalMs: 5,
			now: () => now,
			sleep: async (ms) => {
				now += ms
			},
		}),
	).rejects.toThrow(
		'Artifacts namespace kody-pr-42 is still activating after 1s.',
	)
	expect(fetcher).toHaveBeenCalledTimes(5)
})

function deletionInProgress() {
	return Response.json(
		{
			success: false,
			errors: [
				{
					code: 1000,
					message: 'Namespace deletion is already in progress',
				},
			],
		},
		{ status: 409 },
	)
}

test('deleteArtifactsNamespace treats deletion-in-progress as already gone', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = mockFetch(deletionInProgress())
	await expect(
		deleteArtifactsNamespace({
			...creds,
			namespace: 'kody-pr-42',
			fetcher,
		}),
	).resolves.toBeUndefined()
	expect(fetcher).toHaveBeenCalledTimes(1)
})

test('deleteArtifactsNamespace treats deletion-in-progress on namespace DELETE as already gone', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = mockFetch(ok([]), deletionInProgress())
	await expect(
		deleteArtifactsNamespace({
			...creds,
			namespace: 'kody-pr-42',
			fetcher,
		}),
	).resolves.toBeUndefined()
	expect(fetcher).toHaveBeenCalledTimes(2)
})

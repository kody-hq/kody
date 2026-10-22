import { expect, test, vi } from 'vitest'
import {
	confirmRemoteRefAtCommit,
	RemoteRefNotConfirmedError,
	toFullBranchRef,
} from './confirm-remote-ref.ts'

const remote = 'https://acct.artifacts.cloudflare.net/git/default/repo.git'

test('toFullBranchRef keeps full refs and prefixes branch names', () => {
	expect(toFullBranchRef('main')).toBe('refs/heads/main')
	expect(toFullBranchRef('refs/heads/main')).toBe('refs/heads/main')
})

test('confirmRemoteRefAtCommit resolves once the ref shows the commit, retrying read-after-write lag', async () => {
	const listRefs = vi
		.fn()
		.mockResolvedValueOnce([{ ref: 'refs/heads/main', oid: 'old' }])
		.mockResolvedValueOnce([{ ref: 'refs/heads/main', oid: 'new' }])
	const sleep = vi.fn(async () => undefined)
	await expect(
		confirmRemoteRefAtCommit({
			remote,
			token: 'token',
			ref: 'main',
			commit: 'new',
			delaysMs: [5, 5],
			sleep,
			listRefs,
		}),
	).resolves.toBeUndefined()
	expect(listRefs).toHaveBeenCalledTimes(2)
	expect(listRefs).toHaveBeenCalledWith({
		remote,
		token: 'token',
		prefix: 'refs/heads/main',
	})
	expect(sleep).toHaveBeenCalledTimes(1)
})

test('confirmRemoteRefAtCommit throws with the observed tip when the ref never reaches the commit', async () => {
	const listRefs = vi.fn(async () => [
		{ ref: 'refs/heads/main', oid: 'old' },
		{ ref: 'refs/heads/main-other', oid: 'new' },
	])
	const error = await confirmRemoteRefAtCommit({
		remote,
		token: 'token',
		ref: 'main',
		commit: 'new',
		delaysMs: [1, 1],
		sleep: async () => undefined,
		listRefs,
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(RemoteRefNotConfirmedError)
	expect(error).toMatchObject({
		ref: 'refs/heads/main',
		expectedCommit: 'new',
		observedCommit: 'old',
	})
	expect(listRefs).toHaveBeenCalledTimes(3)
})

test('confirmRemoteRefAtCommit fails closed when the ref listing keeps failing or the ref is missing', async () => {
	const failing = vi.fn(async () => {
		throw new Error('HTTP Error: 500')
	})
	const failed = await confirmRemoteRefAtCommit({
		remote,
		token: 'token',
		ref: 'main',
		commit: 'new',
		delaysMs: [1],
		sleep: async () => undefined,
		listRefs: failing,
	}).catch((caught: unknown) => caught)
	expect(failed).toBeInstanceOf(RemoteRefNotConfirmedError)
	expect((failed as Error).cause).toBeInstanceOf(Error)
	expect(((failed as Error).cause as Error).message).toContain(
		'HTTP Error: 500',
	)

	const missing = await confirmRemoteRefAtCommit({
		remote,
		token: 'token',
		ref: 'main',
		commit: 'new',
		delaysMs: [],
		sleep: async () => undefined,
		listRefs: vi.fn(async () => []),
	}).catch((caught: unknown) => caught)
	expect(missing).toMatchObject({ observedCommit: null })
})

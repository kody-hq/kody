import { createCacheEntry } from '@epic-web/cachified'
import { beforeEach, expect, test, vi } from 'vitest'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'
import type * as artifactsModule from '#worker/repo/artifacts.ts'
import {
	buildForkAncestryCacheKey,
	listingPinIsAncestorOfForkTip,
} from './fork-listing-ancestry.ts'

const mocks = vi.hoisted(() => ({
	addRemote: vi.fn(),
	fetch: vi.fn(),
	init: vi.fn(),
	log: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	isSnapshotOnlyArtifactsRemote: vi.fn<
		typeof artifactsModule.isSnapshotOnlyArtifactsRemote
	>(() => false),
}))

vi.mock('#worker/repo/isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: {
			addRemote: (...args: Array<unknown>) => mocks.addRemote(...args),
			fetch: (...args: Array<unknown>) => mocks.fetch(...args),
			init: (...args: Array<unknown>) => mocks.init(...args),
			log: (...args: Array<unknown>) => mocks.log(...args),
		},
		http: {},
	}),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	isSnapshotOnlyArtifactsRemote: (
		...args: Parameters<typeof artifactsModule.isSnapshotOnlyArtifactsRemote>
	) => mocks.isSnapshotOnlyArtifactsRemote(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mocks.resolveExistingArtifactSourceRepo(...args),
}))

// Answers are cached per isolate by SHA pair, so each case uses its own SHAs.
beforeEach(() => {
	vi.clearAllMocks()
})

function readyRepo() {
	return {
		info: vi.fn(async () => ({
			remote: 'https://artifacts.example.test/package.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token',
		})),
	}
}

function originRepo(repoId: string | null) {
	return vi.fn(async (): Promise<string | null> => repoId)
}

function createFakeKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			get: vi.fn(async (key: string) => {
				const raw = store.get(key)
				return raw == null ? null : JSON.parse(raw)
			}),
			put: vi.fn(async (key: string, value: string) => {
				store.set(key, value)
			}),
			delete: vi.fn(async (key: string) => {
				store.delete(key)
			}),
		},
	}
}

test('listing pin ancestry walks the origin absorb marker and treats missing history as not-ancestor', async () => {
	const sameRepo = originRepo('repo-1')
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'walk-same',
			forkTip: 'walk-same',
			resolveOriginRepoId: sameRepo,
		}),
	).toBe(true)
	expect(sameRepo).not.toHaveBeenCalled()

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([
		{ oid: 'walk-tip' },
		{ oid: 'walk-pin' },
		{ oid: 'walk-root' },
	])
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'walk-pin',
			forkTip: 'walk-tip',
			resolveOriginRepoId: originRepo('repo-1'),
		}),
	).toBe(true)
	expect(mocks.resolveExistingArtifactSourceRepo).toHaveBeenCalledWith(
		expect.anything(),
		'repo-1',
	)
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'walk-tip',
			depth: Number.POSITIVE_INFINITY,
			singleBranch: true,
			tags: false,
		}),
	)

	mocks.log.mockResolvedValue([{ oid: 'walk-tip' }, { oid: 'walk-root' }])
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'walk-new',
			forkTip: 'walk-tip',
			resolveOriginRepoId: originRepo('repo-1'),
		}),
	).toBe(false)

	mocks.isSnapshotOnlyArtifactsRemote.mockReturnValueOnce(true)
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'loopback-pin',
			forkTip: 'loopback-tip',
			resolveOriginRepoId: originRepo('repo-loopback'),
		}),
	).toBe(null)

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValueOnce(null)
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'missing-pin',
			forkTip: 'missing-tip',
			resolveOriginRepoId: originRepo('missing'),
		}),
	).toBe(null)

	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			listingPinnedCommit: 'no-source-pin',
			forkTip: 'no-source-tip',
			resolveOriginRepoId: originRepo(null),
		}),
	).toBe(null)
	expect(mocks.resolveExistingArtifactSourceRepo).toHaveBeenCalledTimes(4)
})

test('listing pin ancestry reuses definite answers without refetching the origin graph', async () => {
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([{ oid: 'reuse-tip' }, { oid: 'reuse-pin' }])
	const resolveOriginRepoId = originRepo('repo-reuse')
	const input = {
		env: {} as Env,
		listingPinnedCommit: 'reuse-pin',
		forkTip: 'reuse-tip',
		resolveOriginRepoId,
	}

	const concurrent = await Promise.all([
		listingPinIsAncestorOfForkTip(input),
		listingPinIsAncestorOfForkTip(input),
	])
	expect(concurrent).toEqual([true, true])
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(true)
	expect(mocks.fetch).toHaveBeenCalledTimes(1)
	expect(resolveOriginRepoId).toHaveBeenCalledTimes(1)

	mocks.log.mockResolvedValue([{ oid: 'reuse-tip' }])
	const notAncestor = { ...input, listingPinnedCommit: 'reuse-other' }
	expect(await listingPinIsAncestorOfForkTip(notAncestor)).toBe(false)
	expect(await listingPinIsAncestorOfForkTip(notAncestor)).toBe(false)
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('listing pin ancestry retries after an unreadable graph instead of caching null', async () => {
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValueOnce(null)
	const input = {
		env: {} as Env,
		listingPinnedCommit: 'flaky-pin',
		forkTip: 'flaky-tip',
		resolveOriginRepoId: originRepo('repo-flaky'),
	}
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(null)

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([{ oid: 'flaky-tip' }, { oid: 'flaky-pin' }])
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(true)
	expect(mocks.resolveExistingArtifactSourceRepo).toHaveBeenCalledTimes(2)
})

test('listing pin ancestry answers from KV without resolving or walking the origin repo', async () => {
	const { kv, store } = createFakeKv()
	const key = buildForkAncestryCacheKey({
		ancestor: 'stored-pin',
		descendant: 'stored-tip',
	})
	store.set(
		derivedCacheKeyPrefix + key,
		JSON.stringify(createCacheEntry(false, { ttl: 60_000 })),
	)
	const resolveOriginRepoId = originRepo('repo-stored')

	expect(
		await listingPinIsAncestorOfForkTip({
			env: { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env,
			listingPinnedCommit: 'stored-pin',
			forkTip: 'stored-tip',
			resolveOriginRepoId,
		}),
	).toBe(false)
	expect(resolveOriginRepoId).not.toHaveBeenCalled()
	expect(mocks.resolveExistingArtifactSourceRepo).not.toHaveBeenCalled()
	expect(mocks.fetch).not.toHaveBeenCalled()
})

test('listing pin ancestry stores walked answers in KV and never stores an unreadable graph', async () => {
	const { kv, store } = createFakeKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([{ oid: 'persist-tip' }, { oid: 'persist-pin' }])

	expect(
		await listingPinIsAncestorOfForkTip({
			env,
			listingPinnedCommit: 'persist-pin',
			forkTip: 'persist-tip',
			resolveOriginRepoId: originRepo('repo-persist'),
		}),
	).toBe(true)
	const key =
		derivedCacheKeyPrefix +
		buildForkAncestryCacheKey({
			ancestor: 'persist-pin',
			descendant: 'persist-tip',
		})
	await vi.waitFor(() => expect(store.has(key)).toBe(true))
	expect(JSON.parse(store.get(key) ?? 'null')).toMatchObject({ value: true })

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValueOnce(null)
	expect(
		await listingPinIsAncestorOfForkTip({
			env,
			listingPinnedCommit: 'unreadable-pin',
			forkTip: 'unreadable-tip',
			resolveOriginRepoId: originRepo('repo-unreadable'),
		}),
	).toBe(null)
	expect(kv.put).toHaveBeenCalledTimes(1)
})

import { createCacheEntry } from '@epic-web/cachified'
import { expect, test, vi } from 'vitest'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'
import { runWithRequestContext } from '#worker/request-context.ts'

const mocks = vi.hoisted(() => ({
	resolveArtifactSourceHead:
		vi.fn<() => Promise<{ branch: string; commit: string | null }>>(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsNamespace: () => 'default',
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mocks.resolveArtifactSourceHead(...(args as [])),
}))

const {
	applyArtifactSourcePushToHeadCache,
	buildArtifactSourceHeadCacheKey,
	resolveCachedArtifactSourceHead,
	resolveFreshArtifactSourceHead,
} = await import('./artifact-head-cache.ts')

type StoredEntry = { value: string; expirationTtl: number | undefined }

function createKv() {
	const store = new Map<string, StoredEntry>()
	const kv = {
		store,
		async get(key: string, type?: string) {
			const stored = store.get(key)
			if (!stored) return null
			return type === 'json' ? JSON.parse(stored.value) : stored.value
		},
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) {
			store.set(key, { value, expirationTtl: options?.expirationTtl })
		},
		async delete(key: string) {
			store.delete(key)
		},
	}
	return kv
}

function createEnv(kv: ReturnType<typeof createKv> | null) {
	return (kv ? { BUNDLE_ARTIFACTS_KV: kv } : {}) as unknown as Env
}

function storedHead(kv: ReturnType<typeof createKv>, env: Env, repoId: string) {
	const raw = kv.store.get(
		derivedCacheKeyPrefix + buildArtifactSourceHeadCacheKey(env, repoId),
	)
	return raw ? (JSON.parse(raw.value) as { value: unknown }).value : undefined
}

function setup(withKv = true) {
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-live',
	})
	const kv = createKv()
	return { kv, env: createEnv(withKv ? kv : null) }
}

test('first read resolves live and later reads come from KV', async () => {
	const { kv, env } = setup()

	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-live' },
	)
	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-live' },
	)
	expect(mocks.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
	expect(storedHead(kv, env, 'repo-1')).toEqual({
		branch: 'main',
		commit: 'commit-live',
	})
})

test('one request resolves a repo once even when several loaders ask', async () => {
	const { env } = setup()
	const request = new Request('https://kody.test/@owner/demo/tree/main')

	await runWithRequestContext(request, () =>
		Promise.all([
			resolveCachedArtifactSourceHead(env, 'repo-1', { request }),
			resolveCachedArtifactSourceHead(env, 'repo-1', { request }),
			resolveCachedArtifactSourceHead(env, 'repo-1'),
		]),
	)
	expect(mocks.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
})

test('a missing HEAD is cached only briefly', async () => {
	const { kv, env } = setup()
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: null,
	})

	await resolveCachedArtifactSourceHead(env, 'repo-1')
	const raw = kv.store.get(
		derivedCacheKeyPrefix + buildArtifactSourceHeadCacheKey(env, 'repo-1'),
	)
	expect(raw?.expirationTtl).toBe(60)
})

test('falls back to the live lookup without a KV binding', async () => {
	const { env } = setup(false)
	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-live' },
	)
	expect(mocks.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
})

test('a stale entry is served immediately and refreshed in the background', async () => {
	const { kv, env } = setup()
	const key =
		derivedCacheKeyPrefix + buildArtifactSourceHeadCacheKey(env, 'repo-1')
	kv.store.set(key, {
		value: JSON.stringify(
			createCacheEntry(
				{ branch: 'main', commit: 'commit-stale' },
				{
					ttl: 5 * 60_000,
					swr: 60 * 60_000,
					createdTime: Date.now() - 10 * 60_000,
				},
			),
		),
		expirationTtl: undefined,
	})

	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-stale' },
	)
	await vi.waitFor(() => {
		expect(storedHead(kv, env, 'repo-1')).toEqual({
			branch: 'main',
			commit: 'commit-live',
		})
	})
	expect(mocks.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
})

test('a push to the cached default branch rewrites the commit without a lookup', async () => {
	const { kv, env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')
	mocks.resolveArtifactSourceHead.mockClear()

	await applyArtifactSourcePushToHeadCache({
		env,
		repoId: 'repo-1',
		ref: 'refs/heads/main',
		after: 'commit-pushed',
	})
	expect(storedHead(kv, env, 'repo-1')).toEqual({
		branch: 'main',
		commit: 'commit-pushed',
	})
	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-pushed' },
	)
	expect(mocks.resolveArtifactSourceHead).not.toHaveBeenCalled()
})

test('a push to another branch leaves the cached HEAD alone', async () => {
	const { kv, env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')

	await applyArtifactSourcePushToHeadCache({
		env,
		repoId: 'repo-1',
		ref: 'refs/heads/feature',
		after: 'commit-feature',
	})
	expect(storedHead(kv, env, 'repo-1')).toEqual({
		branch: 'main',
		commit: 'commit-live',
	})
})

test('a push to a repo nobody has viewed writes nothing', async () => {
	const { kv, env } = setup()
	await applyArtifactSourcePushToHeadCache({
		env,
		repoId: 'repo-unvisited',
		ref: 'refs/heads/main',
		after: 'commit-pushed',
	})
	expect(kv.store.size).toBe(0)
})

test('deleting the default branch drops the cached HEAD', async () => {
	const { kv, env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')
	await applyArtifactSourcePushToHeadCache({
		env,
		repoId: 'repo-1',
		ref: 'refs/heads/main',
		after: '0000000000000000000000000000000000000000',
	})
	expect(storedHead(kv, env, 'repo-1')).toBeUndefined()
})

test('a fresh read sees an external push the cached entry missed and rewrites it', async () => {
	const { kv, env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-pushed',
	})

	await expect(resolveFreshArtifactSourceHead(env, 'repo-1')).resolves.toEqual({
		branch: 'main',
		commit: 'commit-pushed',
	})
	expect(storedHead(kv, env, 'repo-1')).toEqual({
		branch: 'main',
		commit: 'commit-pushed',
	})
	await expect(resolveCachedArtifactSourceHead(env, 'repo-1')).resolves.toEqual(
		{ branch: 'main', commit: 'commit-pushed' },
	)
	expect(mocks.resolveArtifactSourceHead).toHaveBeenCalledTimes(2)
})

test('a fresh read without a KV binding returns the live HEAD', async () => {
	const { env } = setup(false)
	await expect(resolveFreshArtifactSourceHead(env, 'repo-1')).resolves.toEqual({
		branch: 'main',
		commit: 'commit-live',
	})
})

test('a failed fresh read falls back to the last cached HEAD', async () => {
	const { env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')
	mocks.resolveArtifactSourceHead.mockRejectedValue(new Error('artifacts down'))

	await expect(resolveFreshArtifactSourceHead(env, 'repo-1')).resolves.toEqual({
		branch: 'main',
		commit: 'commit-live',
	})
})

test('a failed fresh read with nothing cached rethrows', async () => {
	const { env } = setup()
	mocks.resolveArtifactSourceHead.mockRejectedValue(new Error('artifacts down'))

	await expect(resolveFreshArtifactSourceHead(env, 'repo-1')).rejects.toThrow(
		'artifacts down',
	)
})

test('a stalled fresh read returns the cached HEAD within the timeout', async () => {
	const { env } = setup()
	await resolveCachedArtifactSourceHead(env, 'repo-1')
	mocks.resolveArtifactSourceHead.mockReturnValue(new Promise(() => {}))

	await expect(
		resolveFreshArtifactSourceHead(env, 'repo-1', { timeoutMs: 10 }),
	).resolves.toEqual({ branch: 'main', commit: 'commit-live' })
})

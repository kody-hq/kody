import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	listSavedPackagesByIds: mocks.listSavedPackagesByIds,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const {
	buildPackageSubscriptionTopicGenerationKey,
	buildPackageSubscriptionTopicMapKey,
	bumpPackageSubscriptionTopicGeneration,
	getOrFillPackageSubscriptionTopicMap,
	invalidatePackageSubscriptionTopicMap,
	readPackageSubscriptionTopicMap,
	refreshPackageSubscriptionTopicMap,
	writePackageSubscriptionTopicMap,
} = await import('./subscription-topic-cache.ts')
const { loadMatchingPackageSubscriptions } =
	await import('./admin-package-subscriptions.ts')

function createKv() {
	const store = new Map<string, string>()
	const kv = {
		get: vi.fn(async (key: string, typeOrOpts?: 'json' | { type?: string }) => {
			const value = store.get(key) ?? null
			const asJson =
				typeOrOpts === 'json' ||
				(typeof typeOrOpts === 'object' && typeOrOpts?.type === 'json')
			return asJson && value ? JSON.parse(value) : value
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	} as unknown as KVNamespace
	return { store, kv }
}

function savedPackage(input: {
	id: string
	kodyId: string
	topics?: Array<string>
}) {
	return {
		id: input.id,
		userId: ownerIdFromStored('user-1'),
		name: `@user/${input.kodyId}`,
		kodyId: input.kodyId,
		description: input.kodyId,
		tags: [],
		searchText: null,
		sourceId: `source-${input.id}`,
		hasApp: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-10-02T00:00:00.000Z',
		updatedAt: '2026-10-02T00:00:00.000Z',
		topics: input.topics ?? [],
	}
}

function manifestFor(topics: Array<string>) {
	return {
		manifest: {
			name: '@user/pkg',
			kody: {
				id: 'pkg',
				description: 'pkg',
				subscriptions: Object.fromEntries(
					topics.map((topic) => [
						topic,
						{ handler: './src/handler.ts', description: null },
					]),
				),
			},
		},
	}
}

function seedPackages(packages: Array<ReturnType<typeof savedPackage>>) {
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = packages.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			packages.filter((entry) => input.packageIds.includes(entry.id)),
	)
}

test('wake miss fills KV then a second wake does not reload every manifest', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const packages = [
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['email.message.received'],
		}),
		savedPackage({ id: 'pkg-b', kodyId: 'b', topics: [] }),
		savedPackage({
			id: 'pkg-c',
			kodyId: 'c',
			topics: ['email.message.received'],
		}),
	]
	seedPackages(packages)

	const first = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		topic: 'email.message.received',
	})
	expect(
		first.subscriptions.map((entry) => entry.savedPackage.id).sort(),
	).toEqual(['pkg-a', 'pkg-c'])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(3)
	expect(store.has(buildPackageSubscriptionTopicMapKey('user-1'))).toBe(true)

	mocks.loadPackageManifestBySourceId.mockClear()
	mocks.listSavedPackagesByUserId.mockClear()

	const second = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		topic: 'email.message.received',
	})
	expect(
		second.subscriptions.map((entry) => entry.savedPackage.id).sort(),
	).toEqual(['pkg-a', 'pkg-c'])
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(2)
	expect(
		mocks.loadPackageManifestBySourceId.mock.calls
			.map(([arg]) => (arg as { sourceId: string }).sourceId)
			.sort(),
	).toEqual(['source-pkg-a', 'source-pkg-c'])
})

test('publish refresh changes who matches without waiting for a TTL', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const before = [
		savedPackage({
			id: 'pkg-old',
			kodyId: 'old',
			topics: ['integration.auth.failed'],
		}),
		savedPackage({ id: 'pkg-new', kodyId: 'new', topics: [] }),
	]
	seedPackages(before)

	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})
	const key = buildPackageSubscriptionTopicMapKey('user-1')
	expect(store.has(key)).toBe(true)

	const after = [
		savedPackage({ id: 'pkg-old', kodyId: 'old', topics: [] }),
		savedPackage({
			id: 'pkg-new',
			kodyId: 'new',
			topics: ['integration.auth.failed'],
		}),
	]
	seedPackages(after)

	await refreshPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})

	mocks.loadPackageManifestBySourceId.mockClear()
	const matched = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		topic: 'integration.auth.failed',
	})
	expect(matched.subscriptions.map((entry) => entry.savedPackage.id)).toEqual([
		'pkg-new',
	])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(1)
	expect(mocks.loadPackageManifestBySourceId.mock.calls[0]?.[0]).toEqual(
		expect.objectContaining({ sourceId: 'source-pkg-new' }),
	)
})

test('incomplete scan does not cache a partial topic map', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const packages = [
		savedPackage({
			id: 'pkg-ok',
			kodyId: 'ok',
			topics: ['email.message.received'],
		}),
		savedPackage({
			id: 'pkg-bad',
			kodyId: 'bad',
			topics: ['email.message.received'],
		}),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-pkg-bad') {
				throw new Error('manifest unavailable')
			}
			return manifestFor(['email.message.received'])
		},
	)
	mocks.listSavedPackagesByIds.mockResolvedValue([packages[0]!])

	const first = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		topic: 'email.message.received',
	})
	expect(first.discoveryErrors).toHaveLength(1)
	expect(store.has(buildPackageSubscriptionTopicMapKey('user-1'))).toBe(false)

	mocks.loadPackageManifestBySourceId.mockClear()
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = packages.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			packages.filter((entry) => input.packageIds.includes(entry.id)),
	)

	const second = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		topic: 'email.message.received',
	})
	expect(
		second.subscriptions.map((entry) => entry.savedPackage.id).sort(),
	).toEqual(['pkg-bad', 'pkg-ok'])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(2)
})

test('generation bump makes a late wake write a miss instead of overwriting publish', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	seedPackages([
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['repo.pushed'],
		}),
	])

	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})

	const stale = {
		version: 1 as const,
		userId: ownerIdFromStored('user-1'),
		generation: 0,
		byTopic: { 'repo.pushed': ['pkg-stale'] },
		cachedAt: '2026-10-02T00:00:00.000Z',
	}
	await bumpPackageSubscriptionTopicGeneration({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	await writePackageSubscriptionTopicMap({ env, map: stale })

	// Stale write is rejected; the pre-bump map remains but reads as a miss.
	expect(
		store.get(buildPackageSubscriptionTopicMapKey('user-1')),
	).not.toContain('pkg-stale')
	await expect(
		readPackageSubscriptionTopicMap({
			env,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBeNull()

	seedPackages([
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['repo.pushed'],
		}),
	])
	const refreshed = await refreshPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})
	expect(refreshed?.byTopic['repo.pushed']).toEqual(['pkg-a'])
})

test('generation bump alone forces a miss when map delete fails', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	seedPackages([
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['repo.pushed'],
		}),
	])
	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})
	expect(store.has(buildPackageSubscriptionTopicMapKey('user-1'))).toBe(true)

	kv.delete = vi.fn(async () => {
		throw new Error('kv delete failed')
	}) as unknown as KVNamespace['delete']

	await expect(
		refreshPackageSubscriptionTopicMap({
			env,
			baseUrl: 'https://example.com',
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toEqual(
		expect.objectContaining({
			byTopic: { 'repo.pushed': ['pkg-a'] },
		}),
	)
	const generationAfterRefresh = Number(
		store.get(buildPackageSubscriptionTopicGenerationKey('user-1')),
	)
	expect(generationAfterRefresh).toBeGreaterThan(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-subscription-topic-map-invalidate-failed',
		expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
	)
})

test('concurrent refreshes mint distinct generations so the earlier scan cannot overwrite', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	seedPackages([
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['repo.pushed'],
		}),
	])

	const genA = await bumpPackageSubscriptionTopicGeneration({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	const genB = await bumpPackageSubscriptionTopicGeneration({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(genA).not.toBe(genB)
	expect(store.get(buildPackageSubscriptionTopicGenerationKey('user-1'))).toBe(
		String(genB),
	)

	// Late write from refresh A (shared-increment race class) must be rejected.
	await writePackageSubscriptionTopicMap({
		env,
		map: {
			version: 1,
			userId: ownerIdFromStored('user-1'),
			generation: genA,
			byTopic: { 'repo.pushed': ['pkg-stale'] },
			cachedAt: '2026-10-02T00:00:00.000Z',
		},
	})
	expect(store.has(buildPackageSubscriptionTopicMapKey('user-1'))).toBe(false)

	await writePackageSubscriptionTopicMap({
		env,
		map: {
			version: 1,
			userId: ownerIdFromStored('user-1'),
			generation: genB,
			byTopic: { 'repo.pushed': ['pkg-a'] },
			cachedAt: '2026-10-03T00:00:00.000Z',
		},
	})
	const cached = await readPackageSubscriptionTopicMap({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(cached?.generation).toBe(genB)
	expect(cached?.byTopic['repo.pushed']).toEqual(['pkg-a'])
})

test('invalidate drops the map so the next wake cannot use a stale projection', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	mocks.listSavedPackagesByUserId.mockResolvedValue([])
	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})
	const key = buildPackageSubscriptionTopicMapKey('user-1')
	expect(store.has(key)).toBe(true)
	await invalidatePackageSubscriptionTopicMap({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(store.has(key)).toBe(false)
})

test('written map and generation have no expiration TTL', async () => {
	const { kv } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	mocks.listSavedPackagesByUserId.mockResolvedValue([])
	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
	})
	expect(kv.put).toHaveBeenCalledWith(
		buildPackageSubscriptionTopicMapKey('user-1'),
		expect.any(String),
	)
	for (const call of (kv.put as ReturnType<typeof vi.fn>).mock.calls) {
		expect(call[2]).toBeUndefined()
	}
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	getCommunityPublicCacheVersion,
	invalidateCommunityPublicCache,
} from '#app/data-cache.ts'
import {
	deleteCommunityIconAssets,
	findCommunityIconPath,
	getCommunityIconObject,
	processCommunityIcon,
	refreshCommunityIconForPackagePublish,
	renderCommunityIconFallbackPng,
} from './community-icon.ts'
import type { CommunityListingRecord } from './types.ts'
import {
	createFakeImagesBinding,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const mocks = vi.hoisted(() => ({
	readFirstArtifactFileAtCommit: vi.fn(),
	getEntitySourceById: vi.fn(),
	getCommunityListingById: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readFirstArtifactFileAtCommit: mocks.readFirstArtifactFileAtCommit,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mocks.getEntitySourceById,
}))

vi.mock('./repo.ts', () => ({
	getCommunityListingById: mocks.getCommunityListingById,
	getCommunityListingByOwnerAndPackage:
		mocks.getCommunityListingByOwnerAndPackage,
}))

vi.mock('./snapshot.ts', () => ({}))

const svgSource =
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2563eb"/></svg>'
const svgBytes = new TextEncoder().encode(svgSource)

function createPngHeader(width: number, height: number) {
	const bytes = new Uint8Array(24)
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	bytes.set([0x49, 0x48, 0x44, 0x52], 12)
	new DataView(bytes.buffer).setUint32(16, width)
	new DataView(bytes.buffer).setUint32(20, height)
	return bytes
}

function createFakeKv() {
	const values = new Map<string, string>()
	return {
		values,
		kv: {
			async get(key: string, type?: string) {
				const value = values.get(key)
				if (value == null) return null
				return type === 'json' ? JSON.parse(value) : value
			},
			async put(key: string, value: string) {
				values.set(key, value)
			},
			async delete(key: string) {
				values.delete(key)
			},
			async list(options?: { prefix?: string }) {
				return {
					keys: Array.from(values.keys())
						.filter((name) => name.startsWith(options?.prefix ?? ''))
						.map((name) => ({ name })),
					list_complete: true,
				}
			},
		} as unknown as KVNamespace,
	}
}

function createFakeR2() {
	const values = new Map<string, Uint8Array<ArrayBuffer>>()
	const bucket = {
		async put(key: string, value: Uint8Array<ArrayBuffer>) {
			values.set(key, value)
			return { key }
		},
		async get(key: string) {
			const value = values.get(key)
			if (!value) return null
			return {
				body: new Blob([value]).stream(),
				httpEtag: '"test-etag"',
			}
		},
		async delete(key: string) {
			values.delete(key)
		},
		async list(options?: { prefix?: string }) {
			return {
				objects: Array.from(values.keys())
					.filter((key) => key.startsWith(options?.prefix ?? ''))
					.map((key) => ({ key })),
				truncated: false,
			}
		},
	} as unknown as R2Bucket
	return { bucket, values }
}

function createIconEnv(db = {} as D1Database) {
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values: r2Values } = createFakeR2()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
		USER_METER: createInMemoryUserMeterEnv().env.USER_METER,
	} as unknown as Env
	return { env, kv, bucket, kvValues, r2Values }
}

function createCommunityIconDeletionRaceDbMock() {
	let deleting = false
	// After mirror retirement, the DO-authority path no longer calls DB batch for
	// lease acquire/release. We simulate the account-deletion race by counting
	// SELECT deleting_at queries. assertAccountWritableDb now issues two per
	// gate (live users + personal-org row). Lease acquire uses the first pair;
	// createCommunityIconDescriptor's post-R2 isServableIconCommit uses the
	// second pair while still writable; cache.set's isServableIconCommit is
	// the fifth query and must see deletion so the KV write is skipped.
	let deletingAtSelectCount = 0
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim()
			return {
				bind() {
					return {
						async first<T>() {
							if (normalized.includes('SELECT deleting_at')) {
								deletingAtSelectCount++
								if (deletingAtSelectCount >= 5) deleting = true
								return {
									deleting_at: deleting ? 'now' : null,
									deleted_at: null,
								} as T
							}
							return null
						},
						async run() {
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
		async batch() {
			return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]
		},
	} as unknown as D1Database
}

const listing = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-1'),
	packageId: 'package-1',
	sourceId: 'source-1',
	kodyId: 'github-tools',
	name: '@kentcdodds/github-tools',
	description: 'GitHub tools',
	tags: [],
	category: 'integrations',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
} satisfies CommunityListingRecord

const entitySourceRow = {
	id: listing.sourceId,
	user_id: listing.ownerUserId,
	entity_kind: 'package',
	entity_id: listing.packageId,
	repo_id: 'package-package-1',
	published_commit: listing.pinnedCommit,
	indexed_commit: listing.pinnedCommit,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-07-10T00:00:00.000Z',
	updated_at: '2026-07-10T00:00:00.000Z',
}

function mockArtifactIcon(path: string, bytes: Uint8Array) {
	mocks.getEntitySourceById.mockResolvedValue(entitySourceRow)
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue({ path, bytes })
}

function getPinnedIcon(env: Env) {
	return getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.pinnedCommit,
	})
}

const iconVersions = ['v1', 'v2', 'v3'] as const
const kvIconKey = (version: string, listingId: string, commit: string) =>
	`derived-cache:v1:community-icon:${version}:${listingId}:${commit}`
const r2IconKey = (version: string, listingId: string, commit: string) =>
	`community-icon:${version}/${listingId}/${commit}/asset`

function seedIconAssets(
	stores: Pick<ReturnType<typeof createIconEnv>, 'kvValues' | 'r2Values'>,
	listingId: string,
	commits: Array<string>,
	versions: ReadonlyArray<string> = iconVersions,
) {
	for (const commit of commits) {
		for (const version of versions) {
			stores.kvValues.set(kvIconKey(version, listingId, commit), '{}')
			stores.r2Values.set(
				r2IconKey(version, listingId, commit),
				Uint8Array.from([1]),
			)
		}
	}
}

test('community raster icon formats are validated then fitted to WebP', async () => {
	const process = (
		path: Parameters<typeof processCommunityIcon>[0]['path'],
		sourceBytes: Uint8Array,
	) =>
		processCommunityIcon({
			path,
			sourceBytes,
			images: createFakeImagesBinding(),
		})
	const fitted = { bytes: tinyWebpBytes, contentType: 'image/webp' as const }

	await expect(
		process('community-icon.png', createPngHeader(256, 256)),
	).resolves.toEqual(fitted)
	await expect(
		process('community-icon.png', createPngHeader(5000, 100)),
	).rejects.toThrow('at most 4096px')
	await expect(process('community-icon.svg', svgBytes)).resolves.toEqual(fitted)
	await expect(
		process(
			'community-icon.svg',
			new TextEncoder().encode(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			),
		),
	).rejects.toThrow('active external content')
	const fallbackPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/github-tools',
	)
	expect(Array.from(fallbackPng.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
	expect(
		findCommunityIconPath({
			'community-icon.jpeg': '',
			'community-icon.svg': '',
		}),
	).toBe('community-icon.svg')
	expect(findCommunityIconPath({ 'package.json': '{}' })).toBeNull()
})

test('pinned SVG icons load from Artifacts at the pinned commit', async () => {
	mockArtifactIcon('icon.svg', svgBytes)

	const result = await getPinnedIcon(createIconEnv().env)

	expect(result.descriptor.sourcePath).toBe('icon.svg')
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			commit: listing.pinnedCommit,
		}),
	)
})

test('community icons fall back to the monogram when the package source row is gone', async () => {
	mocks.getEntitySourceById.mockResolvedValue(null)
	mocks.getCommunityListingById.mockResolvedValue(listing)

	const result = await getPinnedIcon(createIconEnv().env)

	expect(result.descriptor).toMatchObject({
		sourcePath: null,
		contentType: 'image/webp',
	})
	expect(mocks.readFirstArtifactFileAtCommit).not.toHaveBeenCalled()
})

test('community icon descriptor caches the R2 reference and repairs a dangling reference', async () => {
	const { env, kvValues, r2Values } = createIconEnv()
	mockArtifactIcon('community-icon.png', createPngHeader(128, 128))

	const first = await getPinnedIcon(env)
	const second = await getPinnedIcon(env)
	expect(first.descriptor.contentType).toBe('image/webp')
	expect(second.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledTimes(1)

	r2Values.delete(first.descriptor.r2Key)
	const repaired = await getPinnedIcon(env)
	expect(repaired.descriptor.r2Key).toBe(first.descriptor.r2Key)
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledTimes(2)

	r2Values.clear()
	kvValues.clear()
	mocks.getCommunityListingById.mockReset()
	mocks.getCommunityListingById
		.mockResolvedValueOnce(listing)
		.mockResolvedValueOnce(null)
	await getPinnedIcon(env)
	expect(kvValues.size).toBe(0)
})

test('community icon cache write loses the race to account deletion', async () => {
	const { env, kvValues } = createIconEnv(
		createCommunityIconDeletionRaceDbMock(),
	)
	mockArtifactIcon('community-icon.png', createPngHeader(128, 128))
	await getPinnedIcon(env)
	// The deletion race is detected via the D1 deleting_at point gate:
	// isServableIconCommit sees deleting_at set (on the fifth SELECT query,
	// during cache.set after icon generation) and skips the KV write.
	expect(kvValues.size).toBe(0)
})

test('community icons ahead of the pinned commit load from the artifact repo at the icon commit', async () => {
	const iconCommit = 'def456'
	const publishedListing = { ...listing, iconCommit }
	mockArtifactIcon('community-icon.png', createPngHeader(128, 128))
	mocks.getEntitySourceById.mockResolvedValue({
		...entitySourceRow,
		published_commit: iconCommit,
	})
	mocks.getCommunityListingById.mockResolvedValue(publishedListing)

	const result = await getCommunityIconObject({
		env: createIconEnv().env,
		listing: publishedListing,
		iconCommit,
	})

	expect(result.descriptor.iconCommit).toBe(iconCommit)
	expect(result.descriptor.r2Key).toContain(`/${iconCommit}/`)
	expect(result.descriptor.sourcePath).toBe('community-icon.png')
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({ commit: iconCommit }),
	)
})

test('deleteCommunityIconAssets removes superseded revisions and keeps servable commits', async () => {
	const { kv, bucket, ...stores } = createIconEnv()
	seedIconAssets(stores, listing.id, ['commit-1', 'commit-2', 'commit-3'])
	seedIconAssets(stores, 'other-listing', ['commit-1'], ['v1', 'v2'])

	await deleteCommunityIconAssets({
		env: { BUNDLE_ARTIFACTS_KV: kv, COMMUNITY_ASSETS: bucket },
		listingId: listing.id,
		keepCommits: ['commit-2'],
	})

	const kept: Array<[version: string, listingId: string, commit: string]> = [
		['v3', listing.id, 'commit-2'],
		['v1', 'other-listing', 'commit-1'],
		['v2', 'other-listing', 'commit-1'],
	]
	expect(Array.from(stores.kvValues.keys()).sort()).toEqual(
		kept.map((key) => kvIconKey(...key)).sort(),
	)
	expect(Array.from(stores.r2Values.keys()).sort()).toEqual(
		kept.map((key) => r2IconKey(...key)).sort(),
	)
})

test('refreshCommunityIconForPackagePublish drops superseded icon caches for active listings', async () => {
	invalidateCommunityPublicCache()
	const versionAfterClear = getCommunityPublicCacheVersion()
	const { env, ...stores } = createIconEnv()
	seedIconAssets(stores, listing.id, [
		listing.pinnedCommit,
		'old-publish',
		'new-publish',
	])

	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		...listing,
		iconCommit: 'new-publish',
	})
	const refresh = (publishedCommit: string) =>
		refreshCommunityIconForPackagePublish({
			env,
			userId: listing.ownerUserId,
			packageId: listing.packageId,
			publishedCommit,
		})
	await refresh('new-publish')

	const kept = [listing.pinnedCommit, 'new-publish']
	expect(Array.from(stores.kvValues.keys()).sort()).toEqual(
		kept.map((commit) => kvIconKey('v3', listing.id, commit)).sort(),
	)
	expect(Array.from(stores.r2Values.keys()).sort()).toEqual(
		kept.map((commit) => r2IconKey('v3', listing.id, commit)).sort(),
	)
	expect(getCommunityPublicCacheVersion()).toBe(versionAfterClear + 1)

	// Without an active listing the hook must be a no-op.
	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	const oldR2Key = r2IconKey('v2', listing.id, 'old-publish')
	stores.r2Values.set(oldR2Key, Uint8Array.from([1]))
	await refresh('newest-publish')
	expect(stores.r2Values.has(oldR2Key)).toBe(true)
	expect(getCommunityPublicCacheVersion()).toBe(versionAfterClear + 1)
	invalidateCommunityPublicCache()
})

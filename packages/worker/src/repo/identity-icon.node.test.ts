import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	buildIdentityIconCacheKey,
	buildIdentityIconR2Key,
	deleteIdentityIconAssets,
	getIdentityIconObject,
	identityIconCommitForKind,
	refreshIdentityIconForSource,
} from './identity-icon.ts'
import type { EntitySourceRow } from './types.ts'
import { createFakeImagesBinding } from '#worker/test-support/images-binding.ts'
import type * as EntitySources from './entity-sources.ts'

const mocks = vi.hoisted(() => ({
	readFirstArtifactFileAtCommit: vi.fn(),
	updateEntitySource: vi.fn<typeof EntitySources.updateEntitySource>(
		async () => true,
	),
}))

vi.mock('./artifact-file.ts', () => ({
	readFirstArtifactFileAtCommit: (...args: Array<unknown>) =>
		mocks.readFirstArtifactFileAtCommit(...args),
}))

vi.mock('./entity-sources.ts', () => ({
	updateEntitySource: (
		...args: Parameters<typeof EntitySources.updateEntitySource>
	) => mocks.updateEntitySource(...args),
}))

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

function source(overrides: Partial<EntitySourceRow> = {}): EntitySourceRow {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-new',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-07-10T00:00:00.000Z',
		updated_at: '2026-07-10T00:00:00.000Z',
		...overrides,
	}
}

function iconEnv() {
	const { kv, values: kvValues } = createFakeKv()
	const { bucket, values: r2Values } = createFakeR2()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: bucket,
		IMAGES: createFakeImagesBinding(),
	} as unknown as Env
	return { env, kvValues, r2Values }
}

test('identity icon commit prefers published for packages and indexed for repos', () => {
	const cases = [
		['package', 'idx', 'pub'],
		['repo', 'idx', 'idx'],
		['repo', null, 'pub'],
	] as const
	for (const [entityKind, indexedCommit, expected] of cases) {
		expect([
			entityKind,
			indexedCommit,
			identityIconCommitForKind({
				entityKind,
				publishedCommit: 'pub',
				indexedCommit,
			}),
		]).toEqual([entityKind, indexedCommit, expected])
	}
})

test('getIdentityIconObject prefers .kody/icon and skips package-app icons unless requested', async () => {
	const { env } = iconEnv()
	const png = createPngHeader(64, 64)
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue({
		path: '.kody/icon.png',
		bytes: png,
	})

	const result = await getIdentityIconObject({
		env,
		repoId: 'repo-1',
		iconCommit: 'commit-1',
		ownerUserId: ownerIdFromStored('user-1'),
		leafName: 'notes',
		includePackageAppIcon: true,
		isServableCommit: async () => true,
	})

	expect(result.descriptor.sourcePath).toBe('.kody/icon.png')
	expect(result.descriptor.contentType).toBe('image/webp')
	expect(mocks.readFirstArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			filePaths: expect.arrayContaining([
				'.kody/icon.png',
				'icons/icon-192.png',
			]),
		}),
	)

	mocks.readFirstArtifactFileAtCommit.mockClear()
	mocks.readFirstArtifactFileAtCommit.mockResolvedValue(null)
	await getIdentityIconObject({
		env,
		repoId: 'repo-2',
		iconCommit: 'commit-2',
		ownerUserId: ownerIdFromStored('user-1'),
		leafName: 'plain-repo',
		includePackageAppIcon: false,
		isServableCommit: async () => true,
	})
	const [lookup] = mocks.readFirstArtifactFileAtCommit.mock.calls[0] as [
		{ filePaths: Array<string> },
	]
	const { filePaths } = lookup
	expect(filePaths).toContain('.kody/icon.png')
	expect(filePaths).not.toContain('icons/icon-192.png')
})

test('deleteIdentityIconAssets keeps the current commit and refresh stamps live repo heads', async () => {
	const { env, kvValues, r2Values } = iconEnv()
	for (const commit of ['old', 'new']) {
		kvValues.set(
			`derived-cache:v1:${buildIdentityIconCacheKey({ repoId: 'repo-1', commit })}`,
			'{}',
		)
		r2Values.set(
			buildIdentityIconR2Key({ repoId: 'repo-1', commit }),
			Uint8Array.from([1]),
		)
	}
	kvValues.set(
		`derived-cache:v1:${buildIdentityIconCacheKey({ repoId: 'repo-2', commit: 'old' })}`,
		'{}',
	)

	await deleteIdentityIconAssets({
		env,
		repoId: 'repo-1',
		keepCommits: ['new'],
	})
	expect(Array.from(kvValues.keys()).sort()).toEqual([
		`derived-cache:v1:${buildIdentityIconCacheKey({ repoId: 'repo-1', commit: 'new' })}`,
		`derived-cache:v1:${buildIdentityIconCacheKey({ repoId: 'repo-2', commit: 'old' })}`,
	])
	expect(Array.from(r2Values.keys())).toEqual([
		buildIdentityIconR2Key({ repoId: 'repo-1', commit: 'new' }),
	])

	await refreshIdentityIconForSource({
		env: { ...env, BUNDLE_ARTIFACTS_KV: undefined } as unknown as Env,
		source: source({ entity_kind: 'package', repo_id: 'repo-1' }),
		iconCommit: 'head-0',
		indexLiveHead: true,
	})
	expect(mocks.updateEntitySource).not.toHaveBeenCalled()
	expect(r2Values.size).toBe(1)

	await refreshIdentityIconForSource({
		env,
		source: source({ entity_kind: 'repo', repo_id: 'repo-1' }),
		iconCommit: 'head-1',
		indexLiveHead: true,
	})
	expect(mocks.updateEntitySource).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			id: 'source-1',
			indexedCommit: 'head-1',
		}),
	)
})

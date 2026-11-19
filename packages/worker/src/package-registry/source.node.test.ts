import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LongRunningExportMessage,
} from '#worker/d1-retry.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	loadPublishedEntitySource: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: mockModule.loadPublishedEntitySource,
	loadPublishedEntityManifest: mockModule.loadPublishedEntityManifest,
}))

const {
	loadPackageSourceBySourceId,
	loadPackageManifestBySourceId,
	loadPackageSourceFromFiles,
} = await import('./source.ts')

const manifest = {
	name: '@kentcdodds/example-package',
	exports: { '.': './index.js' },
	kody: {
		id: 'example-package',
		description: 'Example package',
		app: { entry: 'app.js' },
	},
}

const packageFiles = {
	'package.json': JSON.stringify(manifest),
	'app.js': 'export default { async fetch() { return new Response("ok") } }',
	'index.js': 'export const value = "ok"',
}

function createPackageSourceRow(id: string, publishedCommit: string | null) {
	return {
		id,
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package' as const,
		entity_id: `package-${id}`,
		repo_id: `repo-${id}`,
		published_commit: publishedCommit,
		indexed_commit: publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	}
}

function createPublishedSourcePayload(sourceId: string, commit: string) {
	return {
		source: createPackageSourceRow(sourceId, commit),
		files: packageFiles,
		snapshotCreatedAt: '2026-04-20T00:05:00.000Z',
	}
}

function createLoadSourceInput(sourceId: string) {
	return {
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {
				get: vi.fn(async () => null),
				put: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			} as unknown as KVNamespace,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		sourceId,
	}
}

test('loadPackageSourceBySourceId caches published sources', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow('source-published-1', 'commit-1'),
	)
	mockModule.loadPublishedEntitySource.mockResolvedValue(
		createPublishedSourcePayload('source-published-1', 'commit-1'),
	)

	const input = createLoadSourceInput('source-published-1')
	const first = await loadPackageSourceBySourceId(input)
	const second = await loadPackageSourceBySourceId(input)

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(first).toStrictEqual(second)
	expect(first.files).toEqual(packageFiles)
	expect(first.snapshotCreatedAt).toBe('2026-04-20T00:05:00.000Z')
})

test('loadPackageSourceBySourceId shares in-flight loads', async () => {
	const sourceId = 'source-published-concurrent'
	const commit = 'commit-concurrent-1'
	const { promise, resolve } =
		Promise.withResolvers<ReturnType<typeof createPublishedSourcePayload>>()
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow(sourceId, commit),
	)
	mockModule.loadPublishedEntitySource.mockImplementation(() => promise)

	const input = createLoadSourceInput(sourceId)
	const firstPromise = loadPackageSourceBySourceId(input)
	const secondPromise = loadPackageSourceBySourceId(input)
	resolve(createPublishedSourcePayload(sourceId, commit))
	const [first, second] = await Promise.all([firstPromise, secondPromise])

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
})

test('loadPackageSourceBySourceId evicts failures and skips cache for unpublished sources', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow('source-published-failure', 'commit-failure-1'),
	)
	mockModule.loadPublishedEntitySource
		.mockRejectedValueOnce(new Error('repo load failed'))
		.mockResolvedValueOnce(
			createPublishedSourcePayload(
				'source-published-failure',
				'commit-failure-1',
			),
		)
	const failureInput = createLoadSourceInput('source-published-failure')
	await expect(loadPackageSourceBySourceId(failureInput)).rejects.toThrow(
		'repo load failed',
	)
	await expect(
		loadPackageSourceBySourceId(failureInput),
	).resolves.toMatchObject({
		files: {
			'app.js': packageFiles['app.js'],
			'index.js': packageFiles['index.js'],
		},
	})
	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(2)

	mockModule.loadPublishedEntitySource.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow('source-unpublished-1', null),
	)
	mockModule.loadPublishedEntitySource.mockRejectedValue(
		new Error('Source "source-unpublished-1" has no published commit.'),
	)
	await expect(
		loadPackageSourceBySourceId(createLoadSourceInput('source-unpublished-1')),
	).rejects.toThrow('Source "source-unpublished-1" has no published commit.')
	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
})

test('loadPackageManifestBySourceId reads and caches manifest-only sources', async () => {
	const source = createPackageSourceRow(
		'source-manifest-only-1',
		'commit-manifest-only-1',
	)
	mockModule.getEntitySourceById.mockResolvedValue(source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source,
		content: JSON.stringify(manifest),
		manifest,
	})

	const input = createLoadSourceInput('source-manifest-only-1')
	const first = await loadPackageManifestBySourceId(input)
	const second = await loadPackageManifestBySourceId(input)

	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntitySource).not.toHaveBeenCalled()
	expect(first).toStrictEqual(second)
	expect(first.manifest).toMatchObject({
		name: '@kentcdodds/example-package',
		kody: { id: 'example-package' },
	})
})

test('loadPackageManifestBySourceId reads the serving commit while the published one is held', async () => {
	mockModule.getEntitySourceById.mockResolvedValue({
		...createPackageSourceRow('source-held-1', 'commit-held'),
		serving_commit: 'commit-live',
		held_commit: 'commit-held',
	})
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { source: { published_commit: string } }) => ({
			source: input.source,
			content: JSON.stringify({
				...manifest,
				kody: { ...manifest.kody, description: input.source.published_commit },
			}),
		}),
	)
	const input = createLoadSourceInput('source-held-1')

	const live = await loadPackageManifestBySourceId(input)
	const held = await loadPackageManifestBySourceId({
		...input,
		commit: 'commit-held',
	})

	expect(live.source.published_commit).toBe('commit-live')
	expect(live.manifest.kody.description).toBe('commit-live')
	expect(held.source.published_commit).toBe('commit-held')
	expect(held.manifest.kody.description).toBe('commit-held')
})

test('loadPackageManifestBySourceId retries a transient D1 export error', async () => {
	const source = createPackageSourceRow('source-retry-export', 'commit-retry-1')
	const { app: _app, ...kody } = manifest.kody
	const retryManifest = { ...manifest, kody }
	mockModule.getEntitySourceById
		.mockRejectedValueOnce(
			new Error(`D1_ERROR: ${d1LongRunningExportMessage}.`),
		)
		.mockResolvedValueOnce(source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source,
		content: JSON.stringify(retryManifest),
		manifest: retryManifest,
	})

	vi.useFakeTimers()
	try {
		const resultPromise = loadPackageManifestBySourceId(
			createLoadSourceInput('source-retry-export'),
		)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toMatchObject({
			manifest: {
				name: '@kentcdodds/example-package',
				kody: { id: 'example-package' },
			},
		})
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
})

test('loadPackageSourceFromFiles parses caller files with ownership checks', async () => {
	const source = createPackageSourceRow('source-from-files', 'commit-fork-1')
	const files = {
		'package.json': JSON.stringify({
			name: '@kentcdodds/example-package',
			exports: { '.': './index.js' },
			kody: { id: 'example-package', description: 'Example package' },
		}),
		'index.js': 'export default async function main() { return "ok" }\n',
	}
	const load = () =>
		loadPackageSourceFromFiles({
			env: { APP_DB: {} } as Env,
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-from-files',
			files,
		})

	mockModule.getEntitySourceById.mockResolvedValue(source)
	const loaded = await load()
	expect(loaded.files).toEqual(files)
	expect(loaded.manifest.kody.id).toBe('example-package')
	expect(mockModule.loadPublishedEntitySource).not.toHaveBeenCalled()

	mockModule.getEntitySourceById.mockResolvedValue({
		...source,
		user_id: ownerIdFromStored('user-2'),
	})
	await expect(load()).rejects.toThrow('was not found')
})

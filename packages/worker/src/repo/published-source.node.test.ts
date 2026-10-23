import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	readArtifactSourceSnapshot: vi.fn(),
	readArtifactTreeAtCommit: vi.fn(),
	getSavedPackageById: vi.fn(),
	loadPublishedSourceManifestSnapshot: vi.fn(),
	persistPublishedSourceManifestSnapshot: vi.fn(),
	loadPublishedSourceSnapshot: vi.fn(),
	persistPublishedSourceSnapshot: vi.fn(),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('./artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.readArtifactSourceSnapshot(...args),
}))

vi.mock('./artifact-file.ts', () => ({
	readArtifactTreeAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactTreeAtCommit(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/package-runtime/published-runtime-artifacts.ts')
	>('#worker/package-runtime/published-runtime-artifacts.ts')
	return {
		...actual,
		loadPublishedSourceManifestSnapshot: (...args: Array<unknown>) =>
			mockModule.loadPublishedSourceManifestSnapshot(...args),
		persistPublishedSourceManifestSnapshot: (...args: Array<unknown>) =>
			mockModule.persistPublishedSourceManifestSnapshot(...args),
		loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.loadPublishedSourceSnapshot(...args),
		persistPublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.persistPublishedSourceSnapshot(...args),
	}
})

const { loadPublishedEntityManifest, loadPublishedEntitySource } =
	await import('./published-source.ts')

function createSourceRow() {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	}
}

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env
const loadInput = {
	env,
	userId: ownerIdFromStored('user-1'),
	sourceId: 'source-1',
}

function manifestJson(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kentcdodds/example-package',
		exports: { '.': './index.js' },
		kody: { id: 'example-package', description: 'Example package', ...kody },
	})
}

function mockManifestSnapshot(manifestContent: string) {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		manifestContent,
		createdAt: '2026-04-20T00:00:00.000Z',
	})
}

test('loadPublishedEntityManifest reads only manifest content from stored snapshots', async () => {
	mockManifestSnapshot(manifestJson())

	const manifest = await loadPublishedEntityManifest(loadInput)

	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.readArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
	expect(
		mockModule.persistPublishedSourceManifestSnapshot,
	).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(manifest).toMatchObject({
		source: expect.objectContaining({ id: 'source-1' }),
		manifest: expect.objectContaining({
			name: '@kentcdodds/example-package',
			kody: expect.objectContaining({ id: 'example-package' }),
		}),
	})
})

test('loadPublishedEntitySource persists fetched snapshots for later reuse', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue({
		published_commit: 'commit-1',
		files: {
			'package.json': manifestJson(),
			'index.js': 'export const value = "ok"',
		},
	})
	mockModule.persistPublishedSourceSnapshot.mockResolvedValue(undefined)

	const source = await loadPublishedEntitySource(loadInput)

	expect(mockModule.readArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedSourceSnapshot).toHaveBeenCalledWith({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} },
		userId: ownerIdFromStored('user-1'),
		source: expect.objectContaining({ id: 'source-1' }),
		snapshot: expect.objectContaining({
			files: expect.objectContaining({ 'package.json': expect.any(String) }),
		}),
		recoveredFromArtifacts: true,
	})
	expect(source.files).toMatchObject({
		'index.js': 'export const value = "ok"',
	})
	expect(source.snapshotCreatedAt).toBeNull()
})

test('loadPublishedEntitySource heals a KV miss from the Artifacts git tip', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': manifestJson(),
		'index.js': 'export const value = "healed"',
	})
	mockModule.persistPublishedSourceSnapshot.mockResolvedValue(undefined)

	const source = await loadPublishedEntitySource(loadInput)

	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'commit-1',
	})
	expect(mockModule.persistPublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ recoveredFromArtifacts: true }),
	)
	expect(source.files).toMatchObject({
		'index.js': 'export const value = "healed"',
	})
})

test('loadPublishedEntitySource ignores recovered snapshot createdAt as publish clock', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files: {
			'package.json': manifestJson(),
			'index.js': 'export const value = "healed"',
		},
		createdAt: new Date().toISOString(),
		recoveredFromArtifacts: true,
	})

	const source = await loadPublishedEntitySource(loadInput)

	expect(source.snapshotCreatedAt).toBeNull()
	expect(mockModule.persistPublishedSourceSnapshot).not.toHaveBeenCalled()
})

test('loadPublishedEntitySource surfaces a caller-facing error when heal fails', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('git fetch failed'),
	)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		name: '@kentcdodds/example-package',
	})

	await expect(loadPublishedEntitySource(loadInput)).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('@kentcdodds/example-package') &&
			error.message.includes('Republish the package'),
	)
})

test('loadPublishedEntitySource exposes stored snapshot createdAt as the publish clock', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files: {
			'package.json': manifestJson(),
			'index.js': 'export const value = "ok"',
		},
		createdAt: '2026-04-20T00:05:00.000Z',
	})

	const source = await loadPublishedEntitySource(loadInput)

	expect(source.snapshotCreatedAt).toBe('2026-04-20T00:05:00.000Z')
	expect(mockModule.persistPublishedSourceSnapshot).not.toHaveBeenCalled()
})

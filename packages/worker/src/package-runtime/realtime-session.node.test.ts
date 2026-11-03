import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as FacetNames from '#mcp/app-runner-facet-names.ts'

const mockModule = vi.hoisted(() => ({
	buildPackageAppWorker: vi.fn(),
	createMcpCallerContext: vi.fn(),
	buildFacetName: vi.fn<typeof FacetNames.buildFacetName>(
		(value) => value?.trim() || 'main',
	),
	getSavedPackageById: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#mcp/context.ts', () => ({
	createMcpCallerContext: (...args: Array<unknown>) =>
		mockModule.createMcpCallerContext(...args),
}))

vi.mock('#mcp/app-runner-facet-names.ts', () => ({
	buildFacetName: (...args: Parameters<typeof FacetNames.buildFacetName>) =>
		mockModule.buildFacetName(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
	loadServingPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./package-app.ts', () => ({
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

const { resolvePackageAppWorkerCacheKey } =
	await import('./realtime-session.ts')

const binding = {
	userId: ownerIdFromStored('user-1'),
	packageId: 'package-1',
	kodyId: 'example',
	sourceId: 'source-1',
	baseUrl: 'https://example.com',
}

test('resolvePackageAppWorkerCacheKey encodes binding identity and published commit state', async () => {
	const env = {
		APP_DB: {} as D1Database,
	} as Env

	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-2',
		indexed_commit: 'commit-2',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const publishedCommitCacheKey = await resolvePackageAppWorkerCacheKey({
		env,
		binding,
	})

	expect(publishedCommitCacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			'commit-2',
		]),
	)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledWith({}, 'source-1')

	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const unpublishedCacheKey = await resolvePackageAppWorkerCacheKey({
		env,
		binding,
	})

	expect(unpublishedCacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			null,
		]),
	)
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mocks.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

import {
	findStaticKodyDependencyCycle,
	formatStaticKodyDependencyCycleMessage,
	formatStaticKodyDependencyLoadFailureMessage,
	loadReachableStaticKodyDependencyEdges,
} from './static-dependency-cycles.ts'

test('findStaticKodyDependencyCycle reports reachable loops and ignores unreachable ones', () => {
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/a',
			edges: new Map([
				['@scope/a', ['@scope/b']],
				['@scope/b', ['@scope/a']],
				['@scope/c', ['@scope/d']],
			]),
		}),
	).toEqual(['@scope/a', '@scope/b', '@scope/a'])
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/c',
			edges: new Map([
				['@scope/c', ['@scope/d']],
				['@scope/d', ['@scope/e']],
				['@scope/e', ['@scope/c']],
			]),
		}),
	).toEqual(['@scope/c', '@scope/d', '@scope/e', '@scope/c'])
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/c',
			edges: new Map([
				['@scope/c', ['@scope/a']],
				['@scope/a', ['@scope/b']],
				['@scope/b', ['@scope/a']],
			]),
		}),
	).toEqual(['@scope/a', '@scope/b', '@scope/a'])
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/c',
			edges: new Map([
				['@scope/a', ['@scope/b']],
				['@scope/b', ['@scope/a']],
				['@scope/c', ['@scope/d']],
			]),
		}),
	).toBeNull()
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/missing',
			edges: new Map([['@scope/a', ['@scope/b']]]),
		}),
	).toBeNull()
	expect(
		formatStaticKodyDependencyCycleMessage([
			'@scope/a',
			'@scope/b',
			'@scope/a',
		]),
	).toBe(
		'package.json#kody.dependencies forms a cycle: @scope/a -> @scope/b -> @scope/a.',
	)
	expect(
		formatStaticKodyDependencyLoadFailureMessage({
			packageName: '@scope/c',
			cause: new Error('manifest unavailable'),
		}),
	).toBe(
		'Could not load the saved package manifest for @scope/c while checking package.json#kody.dependencies: manifest unavailable.',
	)
})

test('loadReachableStaticKodyDependencyEdges walks published sibling manifests and treats missing packages as sinks', async () => {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		{ name: '@scope/b', sourceId: 'source-b' },
		{ name: '@scope/c', sourceId: 'source-c' },
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-b') {
				return {
					manifest: { kody: { dependencies: ['@scope/c', '@scope/missing'] } },
				}
			}
			return { manifest: { kody: { dependencies: [] } } }
		},
	)

	const graph = await loadReachableStaticKodyDependencyEdges({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://example.test',
		userId: ownerIdFromStored('user-1'),
		rootPackageName: '@scope/a',
		rootDependencies: ['@scope/b', ' @scope/b '],
	})

	expect(graph).toMatchObject({ ok: true })
	if (!graph.ok) throw new Error('expected loaded edges')
	expect(graph.edges.get('@scope/a')).toEqual(['@scope/b'])
	expect(graph.edges.get('@scope/b')).toEqual(['@scope/c', '@scope/missing'])
	expect(graph.edges.get('@scope/c')).toEqual([])
	expect(graph.edges.get('@scope/missing')).toEqual([])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(2)
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/a',
			edges: graph.edges,
		}),
	).toBeNull()
})

test('loadReachableStaticKodyDependencyEdges fails closed when a saved package manifest cannot load', async () => {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		{ name: '@scope/b', sourceId: 'source-b' },
		{ name: '@scope/c', sourceId: 'source-c' },
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-b') {
				return {
					manifest: { kody: { dependencies: ['@scope/c'] } },
				}
			}
			throw new Error('manifest unavailable')
		},
	)

	await expect(
		loadReachableStaticKodyDependencyEdges({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://example.test',
			userId: ownerIdFromStored('user-1'),
			rootPackageName: '@scope/a',
			rootDependencies: ['@scope/b'],
		}),
	).resolves.toEqual({
		ok: false,
		message:
			'Could not load the saved package manifest for @scope/c while checking package.json#kody.dependencies: manifest unavailable.',
	})
})

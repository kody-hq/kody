import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedCredentialStamp: vi.fn(),
}))

vi.mock('./credential-stamp-store.ts', () => ({
	storePublishedCredentialStamp: vi.fn(),
	resolvePublishedCredentialDepStamps: vi.fn(async () => []),
}))

import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import {
	loadPackageSourceBySourceId,
	loadPackageSourceRowForUser,
} from '#worker/package-registry/source.ts'
import { readPublishedCredentialStamp } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	isCredentialStampScanBudgetFailure,
	runCredentialStampFleet,
} from './credential-stamp-fleet.ts'
import {
	resolvePublishedCredentialDepStamps,
	storePublishedCredentialStamp,
} from './credential-stamp-store.ts'

const listPage = vi.mocked(listSavedPackagesPage)
const loadRow = vi.mocked(loadPackageSourceRowForUser)
const loadSource = vi.mocked(loadPackageSourceBySourceId)
const readStamp = vi.mocked(readPublishedCredentialStamp)
const storeStamp = vi.mocked(storePublishedCredentialStamp)
vi.mocked(resolvePublishedCredentialDepStamps)

const ownerUserId = ownerIdFromStored('org-1')

function savedPackage(id: string) {
	return {
		id,
		userId: ownerUserId,
		name: `@acme/${id}`,
		kodyId: id,
		sourceId: `source-${id}`,
		description: 'Demo',
		tags: [],
		searchText: null,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function sourceRow(id: string, publishedCommit: string | null) {
	return {
		id: `source-${id}`,
		user_id: ownerUserId,
		entity_kind: 'package' as const,
		entity_id: id,
		repo_id: `repo-${id}`,
		published_commit: publishedCommit,
		indexed_commit: publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	}
}

function loadedSource(
	id: string,
	files: Record<string, string>,
	publishedCommit = 'commit',
) {
	return {
		source: sourceRow(id, publishedCommit),
		manifest: {
			name: `@acme/${id}`,
			exports: { '.': './index.ts' },
			kody: { id, description: 'Demo.' },
		},
		files,
	}
}

test('credential stamp fleet dry-run classifies stamped, needs_manifest, and unconvertible', async () => {
	listPage.mockResolvedValueOnce([
		savedPackage('clean'),
		savedPackage('needs'),
		savedPackage('bad'),
		savedPackage('draft'),
	] as never)
	loadRow
		.mockResolvedValueOnce(sourceRow('clean', 'commit-clean') as never)
		.mockResolvedValueOnce(sourceRow('needs', 'commit-needs') as never)
		.mockResolvedValueOnce(sourceRow('bad', 'commit-bad') as never)
		.mockResolvedValueOnce(sourceRow('draft', null) as never)
	loadSource
		.mockResolvedValueOnce(
			loadedSource(
				'clean',
				{
					'package.json': JSON.stringify({
						name: '@acme/clean',
						exports: { '.': './index.ts' },
						kody: { description: 'Clean.', credentials: {} },
					}),
					'index.ts': 'export default async function run() { return 1 }',
				},
				'commit-clean',
			) as never,
		)
		.mockResolvedValueOnce(
			loadedSource(
				'needs',
				{
					'package.json': JSON.stringify({
						name: '@acme/needs',
						exports: { '.': './index.ts' },
						kody: { description: 'Needs.' },
					}),
					'index.ts': [
						"import { credential } from 'kody:runtime'",
						'export default async function run() {',
						'\treturn credential("API_KEY")',
						'}',
					].join('\n'),
				},
				'commit-needs',
			) as never,
		)
		.mockResolvedValueOnce(
			loadedSource(
				'bad',
				{
					'package.json': JSON.stringify({
						name: '@acme/bad',
						exports: { '.': './index.ts' },
						kody: { description: 'Bad.' },
					}),
					'index.ts': [
						"import { credential } from 'kody:runtime'",
						'export default async function run(key: string) {',
						'\treturn credential(key)',
						'}',
					].join('\n'),
				},
				'commit-bad',
			) as never,
		)
	readStamp.mockResolvedValueOnce({
		version: 1,
		keys: [],
		depStamps: [],
		stampHash: 'abc',
	})

	const result = await runCredentialStampFleet({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 10,
	})

	expect(result.dryRun).toBe(true)
	expect(result.scannedPackages).toBe(4)
	expect(result.publishedPackages).toBe(3)
	expect(result.stampedPackages).toBe(1)
	expect(result.needsManifestPackages).toBe(1)
	expect(result.unconvertiblePackages).toBe(1)
	expect(result.skippedUnpublished).toBe(1)
	expect(result.outcomes.map((row) => row.outcome)).toEqual([
		'stamped',
		'needs_manifest',
		'unconvertible',
		'skipped_unpublished',
	])
	expect(result.unconvertibleFailureCodes).toContain('non_literal')
	const unconvertible = result.outcomes.find(
		(row) => row.outcome === 'unconvertible',
	)
	expect(unconvertible?.outcome).toBe('unconvertible')
	if (unconvertible?.outcome === 'unconvertible') {
		expect(unconvertible.blockingFailureCodes).toContain('non_literal')
		expect(unconvertible.blockingFailures.length).toBeGreaterThan(0)
		expect(unconvertible.blockingFailures[0]?.code).toBe('non_literal')
	}
	expect(storeStamp).not.toHaveBeenCalled()
})

test('credential stamp fleet scopes nested package files before seal planning', async () => {
	listPage.mockResolvedValueOnce([savedPackage('nested')] as never)
	const nestedSource = {
		...sourceRow('nested', 'commit-nested'),
		manifest_path: 'packages/nested/package.json',
		source_root: 'packages/nested',
	}
	loadRow.mockResolvedValueOnce(nestedSource as never)
	loadSource.mockResolvedValueOnce({
		source: nestedSource,
		manifest: {
			name: '@acme/nested',
			exports: { '.': './index.ts' },
			kody: { id: 'nested', description: 'Nested.' },
		},
		files: {
			'package.json': JSON.stringify({
				name: '@acme/root',
				exports: { '.': './index.ts' },
				kody: { description: 'Root workspace.' },
			}),
			'packages/nested/package.json': JSON.stringify({
				name: '@acme/nested',
				exports: { '.': './index.ts' },
				kody: {
					description: 'Nested.',
					credentials: {
						NESTED_KEY: {
							description: 'Nested credential.',
						},
					},
				},
			}),
			'packages/nested/index.ts': [
				"import { credential } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn credential("NESTED_KEY")',
				'}',
			].join('\n'),
		},
	} as never)
	readStamp.mockResolvedValueOnce(null)

	const result = await runCredentialStampFleet({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 5,
	})

	expect(result.outcomes[0]?.outcome).toBe('would_restamp')
	expect(result.outcomes[0]?.stampKeyCount).toBe(1)
	expect(result.unconvertiblePackages).toBe(0)
	expect(result.needsManifestPackages).toBe(0)
})

test('credential stamp fleet restamps when existing stamp keys are stale', async () => {
	listPage.mockResolvedValueOnce([savedPackage('stale')] as never)
	loadRow.mockResolvedValueOnce(sourceRow('stale', 'commit-stale') as never)
	loadSource.mockResolvedValueOnce(
		loadedSource(
			'stale',
			{
				'package.json': JSON.stringify({
					name: '@acme/stale',
					exports: { '.': './index.ts' },
					kody: {
						description: 'Stale stamp.',
						credentials: {
							linear: {
								kind: 'mcp',
								description: 'Calls tools on the attached MCP server "linear".',
							},
						},
					},
				}),
				'index.ts': [
					"import { kody } from 'kody:runtime'",
					'export default async function run() {',
					'\treturn kody.mcp.linear.list_issues({})',
					'}',
				].join('\n'),
			},
			'commit-stale',
		) as never,
	)
	// Phase-1 stamp omitted the MCP server key.
	readStamp.mockResolvedValueOnce({
		version: 1,
		keys: [],
		depStamps: [],
		stampHash: 'old',
	})

	const result = await runCredentialStampFleet({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 5,
	})

	expect(result.stampedPackages).toBe(0)
	expect(result.missingStampPackages).toBe(1)
	expect(result.outcomes[0]?.outcome).toBe('would_restamp')
})

test('credential stamp fleet apply restamps seal-ready packages missing a stamp', async () => {
	listPage.mockResolvedValueOnce([savedPackage('missing')] as never)
	loadRow
		.mockResolvedValueOnce(sourceRow('missing', 'commit-missing') as never)
		.mockResolvedValueOnce(sourceRow('missing', 'commit-missing') as never)
	loadSource.mockResolvedValueOnce(
		loadedSource(
			'missing',
			{
				'package.json': JSON.stringify({
					name: '@acme/missing',
					exports: { '.': './index.ts' },
					kody: { description: 'Missing stamp.' },
				}),
				'index.ts': 'export default async function run() { return 1 }',
			},
			'commit-missing',
		) as never,
	)
	readStamp.mockResolvedValueOnce(null)
	storeStamp.mockResolvedValueOnce({
		stamp: { version: 1, keys: [], depStamps: [], stampHash: 'empty' },
		files: {},
	})

	const result = await runCredentialStampFleet({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		limit: 5,
	})

	expect(result.restampedPackages).toBe(1)
	expect(result.outcomes[0]?.outcome).toBe('restamped')
	expect(storeStamp).toHaveBeenCalledOnce()
})

test('isCredentialStampScanBudgetFailure recognizes Durable Object CPU resets', () => {
	expect(
		isCredentialStampScanBudgetFailure(
			new Error('Durable Object reset because of CPU time limit'),
		),
	).toBe(true)
	expect(
		isCredentialStampScanBudgetFailure(new Error('BudgetLimitError: exceeded')),
	).toBe(true)
	const wrapped = new Error('failed to load package source')
	wrapped.cause = new Error('Durable Object reset because of CPU time limit')
	expect(isCredentialStampScanBudgetFailure(wrapped)).toBe(true)
	expect(
		isCredentialStampScanBudgetFailure(
			new Error('credential("KEY") is non-literal'),
		),
	).toBe(false)
	expect(
		isCredentialStampScanBudgetFailure(
			new Error('scheduler overloaded CPU queue for unrelated reason'),
		),
	).toBe(false)
})

test('credential stamp fleet classifies DO CPU resets as deferred_scan_budget, not unconvertible', async () => {
	listPage.mockResolvedValueOnce([savedPackage('huge')] as never)
	loadRow.mockResolvedValueOnce(sourceRow('huge', 'commit-huge') as never)
	loadSource.mockRejectedValueOnce(
		new Error('Durable Object reset because of CPU time limit') as never,
	)

	const result = await runCredentialStampFleet({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 5,
	})

	expect(result.deferredScanBudgetPackages).toBe(1)
	expect(result.unconvertiblePackages).toBe(0)
	expect(result.failedPackages).toBe(0)
	expect(result.outcomes[0]?.outcome).toBe('deferred_scan_budget')
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { deterministicEmbedding } from '#worker/vectorize/embedding.ts'

import { searchUnified, type PackageSearchRow } from './search.ts'
import {
	hydrateTopPackageMatches,
	packageSearchEntityPlugin,
	selectPromotedPackageExportCandidates,
} from './search-entity-plugins/package.ts'
import { resolveJevSearchRecallLimit } from './search-jev-rerank.ts'
import {
	type PackageActionMatch,
	type SearchMatch,
} from './search-format-types.ts'

function createPackageExportProjection(
	subpath: string,
	options: {
		description?: string
		typeDefinition?: string
		functionName?: string
		functionDescription?: string
	} = {},
) {
	return {
		subpath,
		runtimeTarget: null,
		typesPath: null,
		description: options.description ?? null,
		typeDefinition: options.typeDefinition ?? null,
		functions: options.functionName
			? [
					{
						name: options.functionName,
						description: options.functionDescription ?? null,
						typeDefinition: options.typeDefinition ?? null,
						referencedTypes: [],
					},
				]
			: [],
		referencedTypes: [],
	}
}

const exportFn = (subpath: string, functionName: string, description: string) =>
	createPackageExportProjection(subpath, {
		description,
		functionName,
		functionDescription: description,
	})

type ExportProjection = ReturnType<typeof createPackageExportProjection>

function packageRow({
	id,
	kodyId,
	description,
	tags,
	searchText = null,
	exports = [],
	...rest
}: {
	id: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText?: string | null
	exports?: Array<ExportProjection>
} & Pick<Partial<PackageSearchRow>, 'hydrate' | 'readmeSnippet'>) {
	const name = `@kody/${kodyId}`
	const flags = {
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
	}
	return {
		record: {
			id,
			userId: ownerIdFromStored('user-1'),
			name,
			kodyId,
			description,
			tags,
			searchText,
			sourceId: `source-${id}`,
			hasSkills: false,
			...flags,
			lockedAt: null,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		listingAhead: null,
		projection: {
			name,
			kodyId,
			description,
			tags,
			searchText,
			...flags,
			appEntry: null,
			exports,
			jobs: [],
			subscriptions: [],
			webhooks: [],
		},
		...rest,
	} satisfies PackageSearchRow
}

function searchPackages(
	query: string,
	packageRows: Array<PackageSearchRow>,
	limit = 5,
) {
	return searchUnified({
		env: {} as Env,
		query,
		userId: ownerIdFromStored('user-1'),
		limit,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows,
			userSecretRows: [],
			userIntegrationRows: [],
		},
	})
}

function createActionMatch(
	subpath: string,
	score: number,
	matchedTerms: ReadonlyArray<string>,
	exportLocalMatchedTermCount = matchedTerms.length,
): PackageActionMatch {
	return {
		subpath,
		description: subpath,
		typeDefinition: null,
		functions: [
			{
				name: subpath.replace(/^\.\//, ''),
				description: null,
				typeDefinition: null,
			},
		],
		score,
		matchedTerms: [...matchedTerms],
		exportLocalMatchedTermCount,
	}
}

test('selectPromotedPackageExportCandidates promotes close runners-up, keeps a clear winner, and looks past the display top-3', () => {
	const cases: Array<[string, Array<PackageActionMatch>, Array<string>]> = [
		[
			'close runners-up',
			[
				createActionMatch('./create-status', 0.82, [
					'twitter',
					'create',
					'status',
				]),
				createActionMatch('./send-status', 0.78, ['twitter', 'send', 'status']),
				createActionMatch('./like-status', 0.74, ['twitter', 'like', 'status']),
			],
			['./create-status', './send-status', './like-status'],
		],
		[
			'clear gap',
			[
				createActionMatch('./bond-area-shades', 0.9, [
					'bond',
					'area',
					'shades',
				]),
				createActionMatch('./other-export', 0.55, ['bond', 'other']),
			],
			['./bond-area-shades'],
		],
		// Nested display would only keep the three weaks; promotion must still
		// see the stronger multi-term export when the full list is uncapped.
		[
			'beyond display top-3',
			[
				createActionMatch('./weak-a', 0.4, ['alpha'], 1),
				createActionMatch('./weak-b', 0.39, ['alpha'], 1),
				createActionMatch('./weak-c', 0.38, ['alpha'], 1),
				createActionMatch(
					'./create-status',
					0.5,
					['twitter', 'create', 'status'],
					2,
				),
			],
			['./create-status'],
		],
	]
	expect(
		cases.map(([name, matches]) => [
			name,
			selectPromotedPackageExportCandidates(matches).map(
				(match) => match.subpath,
			),
		]),
	).toEqual(cases.map(([name, , expected]) => [name, expected]))
})

test('searchUnified promotes strong package exports into first-pass ranked hits', async () => {
	const alpha = {
		id: 'pkg-alpha',
		kodyId: 'pkg-alpha',
		description: 'Alpha helpers.',
		tags: ['alpha', 'module-a'],
		searchText: 'module-a module-b helpers',
	}
	const runTaskAction = expect.objectContaining({
		subpath: './module-a',
		functions: [expect.objectContaining({ name: 'runTask' })],
	})
	const result = await searchPackages('module-a run task', [
		packageRow({
			...alpha,
			exports: [
				createPackageExportProjection('./module-a', {
					description: 'Run module-a task.',
					functionName: 'runTask',
					functionDescription: 'Run module-a task.',
					typeDefinition:
						'export declare function runTask(params: TaskParams): Promise<JsonObject>',
				}),
				exportFn('./module-b', 'searchRecords', 'Search module-b records.'),
			],
		}),
	])
	const alphaMatches = result.matches.flatMap((match) =>
		match.type === 'package' && match.kodyId === 'pkg-alpha' ? [match] : [],
	)
	expect(
		alphaMatches.find((match) => match.exportSubpath === './module-a'),
	).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
		exportSubpath: './module-a',
		actionMatches: [runTaskAction],
	})
	const packageIndexMatch = alphaMatches.find(
		(match) => match.exportSubpath == null,
	)
	expect(packageIndexMatch).toMatchObject({ type: 'package' })
	expect(packageIndexMatch?.actionMatches).toEqual(
		expect.arrayContaining([runTaskAction]),
	)

	const broadQuery = await searchPackages('alpha helpers overview', [
		packageRow({
			...alpha,
			exports: [
				createPackageExportProjection('./module-a', {
					description: 'Run module-a task.',
					functionName: 'runTask',
				}),
				exportFn(
					'./unrelated-widget',
					'spinWidget',
					'Spin the unrelated widget thrice.',
				),
			],
		}),
	])
	const broadPackageMatches = broadQuery.matches.filter(
		(match) => match.type === 'package',
	)
	expect(
		broadPackageMatches.every((match) => match.exportSubpath == null),
	).toBe(true)
	expect(
		broadPackageMatches.find((match) => match.kodyId === 'pkg-alpha'),
	).toMatchObject({ type: 'package', kodyId: 'pkg-alpha', actionMatches: [] })
})

test('searchUnified promotes close sibling exports on alias terms and surfaces the operate export from parent tags', async () => {
	const socialRow = packageRow({
		id: 'pkg-social',
		kodyId: 'social-post',
		description: 'Social status helpers.',
		tags: ['twitter', 'microblog'],
		searchText: 'status create like send',
		exports: [
			exportFn(
				'./create-status',
				'createStatus',
				'Create a new status update on the timeline.',
			),
			exportFn(
				'./like-status',
				'likeStatus',
				'Like an existing status on the timeline.',
			),
			exportFn(
				'./send-direct',
				'sendDirect',
				'Send a direct message to a recipient.',
			),
		],
	})
	const exportSubpathsFor = async (query: string) =>
		(await searchPackages(query, [socialRow], 8)).matches.flatMap((match) =>
			match.type === 'package' &&
			match.kodyId === 'social-post' &&
			match.exportSubpath != null
				? [match.exportSubpath]
				: [],
		)

	// Alias + shared export terms (no operate verb) so create/like stay near-tied.
	expect(await exportSubpathsFor('twitter status')).toEqual(
		expect.arrayContaining(['./create-status', './like-status']),
	)
	expect(await exportSubpathsFor('twitter create status')).toContain(
		'./create-status',
	)
})

test('searchUnified hydrates lean package rows before promoting export candidates', async () => {
	const homeControls = {
		id: 'home-controls-pkg',
		kodyId: 'home-controls',
		description: 'Home controls package.',
	}
	const hydrate = vi.fn(async () => ({
		projection: packageRow({
			...homeControls,
			tags: ['home', 'shades'],
			exports: [
				exportFn(
					'./bond-area-shades',
					'setBondAreaShades',
					'Dim bond area shades for evening.',
				),
			],
		}).projection,
		readmeSnippet: null,
	}))
	const result = await searchPackages('bond area shades set', [
		packageRow({
			...homeControls,
			tags: ['home', 'shades', 'bond-area-shades'],
			searchText: 'bond area shades',
			readmeSnippet: null,
			hydrate,
		}),
	])
	expect(hydrate).toHaveBeenCalled()
	expect(
		result.matches.some(
			(match) =>
				match.type === 'package' &&
				match.exportSubpath === './bond-area-shades',
		),
	).toBe(true)
})

test('hydrateTopPackageMatches keeps export hits aligned with exportSubpath', async () => {
	const homeControls = {
		id: 'home-controls-pkg',
		kodyId: 'home-controls',
		description: 'Home controls package.',
		tags: ['home'],
	}
	const hydrate = vi.fn(async () => ({
		projection: packageRow({
			...homeControls,
			exports: [
				exportFn(
					'./bond-area-shades',
					'setBondAreaShades',
					'Dim bond area shades.',
				),
				exportFn(
					'./other-export',
					'otherHelper',
					'Unrelated other export helpers.',
				),
			],
		}).projection,
		readmeSnippet: {
			path: 'README.md',
			snippet: 'Home controls intent.',
			truncated: false,
		},
	}))
	const match: Extract<SearchMatch, { type: 'package' }> = {
		type: 'package',
		packageId: 'home-controls-pkg',
		kodyId: 'home-controls',
		name: '@kody/home-controls',
		title: '@kody/home-controls setBondAreaShades',
		description: 'Dim bond area shades.',
		tags: ['home'],
		hasApp: false,
		hidden: false,
		exportSubpath: './bond-area-shades',
		actionMatches: [
			{
				subpath: './bond-area-shades',
				description: 'Dim bond area shades.',
				typeDefinition: null,
				functions: [
					{
						name: 'setBondAreaShades',
						description: 'Dim bond area shades.',
						typeDefinition: null,
					},
				],
				score: 0.9,
				matchedTerms: ['bond', 'area', 'shades'],
			},
		],
	}
	await hydrateTopPackageMatches({
		query: 'bond area shades set',
		matches: [match],
		rows: [packageRow({ ...homeControls, readmeSnippet: null, hydrate })],
	})
	expect(hydrate).toHaveBeenCalled()
	expect(match.actionMatches).toEqual([
		expect.objectContaining({
			subpath: './bond-area-shades',
			functions: [expect.objectContaining({ name: 'setBondAreaShades' })],
		}),
	])
	expect(match.readmeSnippet).toMatchObject({
		path: 'README.md',
		snippet: 'Home controls intent.',
	})
})

test('package candidates hydrate the requested page, not Jev wide recall', async () => {
	const rowCount = 45
	const query = 'create github issue'
	async function hydratedCountFor(pageLimit: number) {
		const hydratedIds: Array<string> = []
		const rows = Array.from({ length: rowCount }, (_, index) => {
			const kodyId = `github-helper-${String(index)}`
			const row = packageRow({
				id: `pkg-${String(index)}`,
				kodyId,
				description: 'Create a github issue from a report.',
				tags: ['github'],
				searchText: 'github issue create',
				readmeSnippet: null,
			})
			return {
				...row,
				hydrate: async () => {
					hydratedIds.push(kodyId)
					return { projection: row.projection, readmeSnippet: null }
				},
			}
		})
		const candidates = await packageSearchEntityPlugin.buildCandidates({
			env: {} as Env,
			query,
			limit: resolveJevSearchRecallLimit({
				limit: pageLimit,
				widerRecall: true,
			}),
			pageLimit,
			offline: true,
			userId: ownerIdFromStored('user-1'),
			registry: buildCapabilityRegistry([]),
			optionalRows: {
				packageRows: rows,
				userSecretRows: [],
				userIntegrationRows: [],
			},
			queryEmbedding: deterministicEmbedding(query),
		})
		expect(candidates.length).toBe(rowCount)
		return new Set(hydratedIds).size
	}
	expect(await hydratedCountFor(15)).toBe(15)
	expect(await hydratedCountFor(30)).toBe(30)
})

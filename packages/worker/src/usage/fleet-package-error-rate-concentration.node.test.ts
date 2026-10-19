import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const queryAnalyticsEngineSql = vi.fn()

vi.mock('./aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

const {
	buildFleetPackageErrorRateConcentrationPackageQuery,
	buildFleetPackageErrorRateConcentrationQuery,
	foldFleetPackageErrorRateConcentrationRows,
	parseFleetPackageErrorRateConcentration,
	resolveFleetPackageErrorRateConcentration,
} = await import('./fleet-package-error-rate-concentration.ts')
const { classifyFleetPackageErrorRateConcentrationKind } =
	await import('#universal/fleet-package-error-rate-concentration.ts')

const jettPackageIds = {
	dji: '11111111-1111-4111-8111-111111111111',
	earth: '22222222-2222-4222-8222-222222222222',
	analysis: '33333333-3333-4333-8333-333333333333',
} as const

function createConcentrationDb(
	input: {
		users?: Array<{ stable_user_id: string; username: string }>
		packages?: Array<{ id: string; kody_id: string }>
	} = {},
) {
	const users = input.users ?? [
		{ stable_user_id: 'jett-user', username: 'jett' },
	]
	const packages = input.packages ?? [
		{ id: jettPackageIds.dji, kody_id: 'dji-cloud-relay-staging-deploy' },
		{
			id: jettPackageIds.earth,
			kody_id: 'earthranger-relay-staging-deploy',
		},
		{ id: jettPackageIds.analysis, kody_id: 'analysis-staging-deploy' },
	]
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							if (query.includes('FROM users')) {
								return {
									results: users.filter((user) =>
										params.includes(user.stable_user_id),
									),
								}
							}
							if (query.includes('FROM saved_packages')) {
								return {
									results: packages.filter((pkg) => params.includes(pkg.id)),
								}
							}
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const recentWindow = {
	dataset: 'kody_usage_events',
	recentStart: new Date('2026-09-01T00:00:00.000Z'),
	recentEnd: new Date('2026-09-01T01:00:00.000Z'),
}

function resolveConcentration(db: D1Database, recentErrors: number) {
	return resolveFleetPackageErrorRateConcentration({
		env: {
			APP_DB: db,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		...recentWindow,
		recentErrors,
	})
}

const adaAndBea = [
	{ stable_user_id: 'user-a', username: 'ada' },
	{ stable_user_id: 'user-b', username: 'bea' },
]

test('fleet package error-rate concentration classifies, names, and stays identifier-safe', async () => {
	const kinds: Array<[number, number, string]> = [
		[0.8, 0.8, 'one_account'],
		[0.5, 0.85, 'few_accounts'],
		[0.3, 0.6, 'fleet'],
	]
	expect(
		kinds.map(([topOwnerShare, topFewShare]) =>
			classifyFleetPackageErrorRateConcentrationKind({
				topOwnerShare,
				topFewShare,
			}),
		),
	).toEqual(kinds.map(([, , kind]) => kind))

	const folded = foldFleetPackageErrorRateConcentrationRows(
		[
			{ user_id: ownerIdFromStored('jett-user'), error_count: 90 },
			{ user_id: ownerIdFromStored('quiet-user'), error_count: 2 },
		],
		92,
	)
	expect(folded.recentErrors).toBe(92)
	expect(folded.ownerCount).toBe(2)
	expect(folded.topOwnerShare).toBeCloseTo(90 / 92)
	expect(folded.ranked[0]).toMatchObject({
		ownerId: ownerIdFromStored('jett-user'),
		errors: 90,
		entityIds: [],
	})
	const truncatedFleet = foldFleetPackageErrorRateConcentrationRows(
		Array.from({ length: 50 }, (_, index) => ({
			user_id: `user-${index}`,
			entity_id: `pkg-${index}`,
			error_count: 1,
		})),
		200,
	)
	expect(truncatedFleet.topOwnerShare).toBe(1 / 200)
	expect(
		classifyFleetPackageErrorRateConcentrationKind({
			topOwnerShare: truncatedFleet.topOwnerShare,
			topFewShare: truncatedFleet.topFewShare,
		}),
	).toBe('fleet')

	const query = buildFleetPackageErrorRateConcentrationQuery(recentWindow)
	expect(query).toContain('blob1 AS user_id')
	expect(query).toContain('GROUP BY user_id')
	expect(query).not.toContain('GROUP BY user_id, entity_id')
	expect(query).toContain("blob4 = 'error'")
	expect(query).not.toContain('caught')
	const packageQuery = buildFleetPackageErrorRateConcentrationPackageQuery({
		...recentWindow,
		ownerIds: ['jett-user'],
	})
	expect(packageQuery).toContain("blob1 IN ('jett-user')")
	expect(packageQuery).toContain('GROUP BY user_id, entity_id')
	expect(packageQuery).toContain('LIMIT 5')

	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) =>
			input.query.includes('GROUP BY user_id, entity_id')
				? [
						[jettPackageIds.dji, 40],
						[jettPackageIds.earth, 30],
						[jettPackageIds.analysis, 20],
					].map(([entity_id, error_count]) => ({
						user_id: ownerIdFromStored('jett-user'),
						entity_id,
						error_count,
					}))
				: [{ user_id: ownerIdFromStored('jett-user'), error_count: 90 }],
	)
	const concentration = await resolveConcentration(createConcentrationDb(), 90)
	expect(concentration).toEqual({
		kind: 'one_account',
		recent_errors: 90,
		owner_count: 1,
		package_count: 3,
		top_owner_share: 1,
		owners: [
			{
				username: 'jett',
				error_share: 1,
				packages: [
					{ kody_id: 'dji-cloud-relay-staging-deploy' },
					{ kody_id: 'earthranger-relay-staging-deploy' },
					{ kody_id: 'analysis-staging-deploy' },
				],
			},
		],
	})
	expect(JSON.stringify(concentration)).not.toContain('user_id')
	expect(JSON.stringify(concentration)).not.toContain('jett-user')
	expect(JSON.stringify(concentration)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)

	queryAnalyticsEngineSql.mockImplementation(async () =>
		['a', 'b', 'c', 'd', 'e'].map((suffix) => ({
			user_id: `user-${suffix}`,
			error_count: 20,
		})),
	)
	expect(
		await resolveConcentration(
			createConcentrationDb({ users: adaAndBea }),
			100,
		),
	).toMatchObject({ kind: 'fleet', owner_count: 5, owners: [] })

	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes("blob1 IN ('user-a')")) {
				return Array.from({ length: 5 }, (_, index) => ({
					user_id: ownerIdFromStored('user-a'),
					entity_id: `pkg-a-${index}`,
					error_count: 10 - index,
				}))
			}
			if (input.query.includes("blob1 IN ('user-b')")) {
				return [
					{
						user_id: ownerIdFromStored('user-b'),
						entity_id: 'pkg-b',
						error_count: 1,
					},
				]
			}
			return [
				{ user_id: ownerIdFromStored('user-a'), error_count: 50 },
				{ user_id: ownerIdFromStored('user-b'), error_count: 40 },
			]
		},
	)
	const few = await resolveConcentration(
		createConcentrationDb({
			users: adaAndBea,
			packages: [
				{ id: 'pkg-a-0', kody_id: 'ada-relay' },
				{ id: 'pkg-b', kody_id: 'bea-relay' },
			],
		}),
		100,
	)
	expect(few).toMatchObject({
		kind: 'few_accounts',
		owners: [
			{ username: 'ada', packages: [{ kody_id: 'ada-relay' }] },
			{ username: 'bea', packages: [{ kody_id: 'bea-relay' }] },
		],
	})

	expect(parseFleetPackageErrorRateConcentration(null)).toBeNull()
	expect(
		parseFleetPackageErrorRateConcentration({
			kind: 'one_account',
			recent_errors: 90,
			owner_count: 1,
			package_count: 3,
			top_owner_share: 1,
			owners: [
				{
					username: 'jett',
					error_share: 1,
					packages: [{ kody_id: 'dji-cloud-relay-staging-deploy' }],
				},
			],
		}),
	).toMatchObject({ kind: 'one_account', owners: [{ username: 'jett' }] })
})

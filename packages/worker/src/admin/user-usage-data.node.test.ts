import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { type DailyEntitlementResource } from '#universal/plans.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { type AdminUsageRollup } from '#universal/loader-data.ts'
import { loadAdminUserUsageData } from './user-usage-data.ts'
import {
	isLiveSeatCountQuery,
	mockLiveSeatCountRow,
} from '#worker/test-support/live-seat-count-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
type UserRow = {
	id: number
	username: string
	email: string
	plan: string
	stripe_plan?: string | null
	stripe_price_id?: string | null
	stable_user_id: string
	personal_org_id?: string | null
	org_id?: string
}

type UsageRollupRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	caught_count?: number
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

type ResourceCount = Partial<
	Record<
		| 'saved_packages'
		| 'scheduled_jobs'
		| 'repo_sessions'
		| 'stored_email_messages'
		| 'secrets'
		| 'concurrent_workflows',
		number
	>
>

const defaultNow = new Date('2026-07-05T12:00:00.000Z')

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createUsageRepoSessionRow(
	userId: string,
	index: number,
): RepoSessionRow {
	const id = `usage-session-${index}`
	return {
		id,
		user_id: ownerIdFromStored(userId),
		source_id: `source-${index}`,
		source_repo_id: `repo-${index}`,
		session_branch: `sessions/${id}`,
		source_branch: 'main',
		base_commit: 'base',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-07-05T00:00:00.000Z',
		updated_at: '2026-07-05T00:00:00.000Z',
	}
}

function createAdminUserUsageTestDb(input: {
	users: Array<UserRow>
	usageRollups?: Array<UsageRollupRow>
	resourceCounts?: Record<string, ResourceCount>
}) {
	const { users, usageRollups = [], resourceCounts = {} } = input

	function countForQuery(normalizedQuery: string, userId: string) {
		const counts = resourceCounts[userId] ?? {}
		if (isLiveSeatCountQuery(normalizedQuery)) {
			return mockLiveSeatCountRow().count
		}
		if (normalizedQuery.includes('from saved_packages')) {
			return counts.saved_packages ?? 0
		}
		if (normalizedQuery.includes('from jobs')) {
			return counts.scheduled_jobs ?? 0
		}
		if (normalizedQuery.includes('from secret_entries')) {
			return counts.secrets ?? 0
		}
		return null
	}

	return {
		prepare(query: string) {
			const normalizedQuery = normalizeQuery(query)
			const createStatement = (params: Array<unknown>) => ({
				async first<T>() {
					if (
						normalizedQuery.includes('from users') &&
						normalizedQuery.includes('join orgs') &&
						normalizedQuery.includes('stripe_price_id') &&
						normalizedQuery.includes('stripe_credits_eligible')
					) {
						const user = users.find((row) => row.stable_user_id === params[0])
						if (!user) return null
						const orgId =
							user.org_id ?? user.personal_org_id ?? user.stable_user_id
						return {
							...user,
							personal_org_id: user.personal_org_id ?? orgId,
							org_id: orgId,
						} as T
					}
					if (
						normalizedQuery.includes('from credit_wallets where user_id = ?')
					) {
						return null as T | null
					}
					if (
						normalizedQuery.includes("r.name = 'admin'") &&
						normalizedQuery.includes('stable_user_id')
					) {
						return null
					}
					if (
						normalizedQuery.includes(
							'select 1 as present from users where stable_user_id = ?',
						)
					) {
						const exists = users.some(
							(user) => user.stable_user_id === params[0],
						)
						return (exists ? { present: 1 } : null) as T | null
					}
					const count = countForQuery(normalizedQuery, String(params[0]))
					if (count !== null) return { count } as T
					// Cold storage bootstrap seeds from calculateUserD1StorageBytes.
					if (normalizedQuery.includes('sum(')) {
						return { count: 0 } as T
					}
					throw new Error(`Unsupported first query: ${query}`)
				},
				async all<T>() {
					if (
						normalizedQuery.includes('from usage_rollups') &&
						normalizedQuery.includes('where user_id = ?')
					) {
						return {
							results: usageRollups
								.filter((row) => row.user_id === params[0])
								.sort(
									(left, right) =>
										right.month.localeCompare(left.month) ||
										left.metric.localeCompare(right.metric),
								) as Array<T>,
						}
					}
					return { results: [] as Array<T> }
				},
				async run() {
					throw new Error(`Unsupported run query: ${query}`)
				},
			})
			return {
				...createStatement([]),
				bind(...params: Array<unknown>) {
					return createStatement(params)
				},
			}
		},
	} as unknown as D1Database
}

function createUsageEnv(
	env: { APP_DB: D1Database } & Record<string, unknown>,
	resourceCounts: Record<string, ResourceCount>,
) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(env.APP_DB)
	for (const [userId, counts] of Object.entries(resourceCounts)) {
		const rows = repoSessionIndex.indexes.get(userId) ?? new Map()
		for (let index = 0; index < (counts.repo_sessions ?? 0); index += 1) {
			const row = createUsageRepoSessionRow(userId, index)
			rows.set(row.id, row)
		}
		repoSessionIndex.indexes.set(userId, rows)
	}
	const mailbox = {
		idFromName(userId: string) {
			return { userId } as unknown as DurableObjectId
		},
		get(id: DurableObjectId) {
			const userId = (id as unknown as { userId: string }).userId
			return {
				async countMessages() {
					return {
						total: resourceCounts[userId]?.stored_email_messages ?? 0,
					}
				},
			}
		},
	} as unknown as DurableObjectNamespace
	return {
		...env,
		...meter.env,
		...runLog.env,
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
		MAILBOX: mailbox,
		meter,
		runLog,
	}
}

/**
 * One seeded user with rollups (`[metric, month, eventCount, extra?]`),
 * resource counts, and UserMeter daily counters for `defaultNow`'s day.
 */
async function setupUsageUser(input: {
	plan: string
	stripe?: Pick<UserRow, 'stripe_plan' | 'stripe_price_id'>
	rollups?: Array<[string, string, number, Partial<UsageRollupRow>?]>
	resourceCounts?: ResourceCount
	meter?: Partial<Record<DailyEntitlementResource, number>>
	wrapDb?: (db: D1Database) => D1Database
	extraEnv?: Record<string, unknown>
	/** When set, personal org id differs from the person stable id. */
	distinctPersonalOrgId?: string
}) {
	const personId = testStableUserIdFromEmail(
		`${input.plan}-${crypto.randomUUID()}@example.com`,
	)
	const usageUserId = input.distinctPersonalOrgId ?? personId
	const resourceCounts = { [usageUserId]: input.resourceCounts ?? {} }
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 1,
				username: 'usage-user',
				email: 'usage-user@example.com',
				plan: input.plan,
				stable_user_id: personId,
				personal_org_id: usageUserId,
				org_id: usageUserId,
				...input.stripe,
			},
		],
		usageRollups: (input.rollups ?? []).map(
			([metric, month, event_count, extra]) => ({
				user_id: usageUserId,
				metric,
				month,
				event_count,
				error_count: 0,
				caught_count: 0,
				total_duration_ms: 0,
				total_cpu_ms: 0,
				total_bytes: 0,
				...extra,
			}),
		),
		resourceCounts,
	})
	const env = createUsageEnv(
		{ APP_DB: input.wrapDb?.(db) ?? db, ...input.extraEnv },
		resourceCounts,
	)
	for (const [resource, count] of Object.entries(input.meter ?? {})) {
		await env.meter.seed({
			userId: usageUserId,
			resource: resource as DailyEntitlementResource,
			day: utcDayKey(defaultNow),
			count,
		})
	}
	return {
		usageUserId,
		personId,
		env,
		load: (now = defaultNow) =>
			loadAdminUserUsageData(env as unknown as Env, personId, now),
	}
}

function getEventCount(
	usage: Array<AdminUsageRollup> | undefined,
	metric: AdminUsageRollup['metric'],
) {
	return usage?.find((row) => row.metric === metric)?.eventCount ?? 0
}

test('loadAdminUserUsageData returns null for unknown users and zeroed usage for empty rollups', async () => {
	expect(
		await loadAdminUserUsageData(
			createUsageEnv(
				{ APP_DB: createAdminUserUsageTestDb({ users: [] }) },
				{},
			) as unknown as Env,
			'missing-stable-user',
			defaultNow,
		),
	).toBeNull()

	const { personId, load } = await setupUsageUser({ plan: 'standard' })
	const data = await load()

	expect(data?.currentMonth).toBe('2026-07')
	expect(data?.today).toBe('2026-07-05')
	expect(data?.stableUserId).toBe(personId)
	expect(data?.currentMonthUsage.every((row) => row.eventCount === 0)).toBe(
		true,
	)
	expect(data?.monthUsage).toEqual([
		{
			month: '2026-07',
			usage: expect.arrayContaining([
				expect.objectContaining({ metric: 'execute', eventCount: 0 }),
			]),
		},
	])
	expect(data?.warnings).toEqual([])
	const zeroDynamicWorkerCost = {
		uniqueWorkerDays: 0,
		estimatedGrossUsd: 0,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 350,
	}
	expect(data?.dynamicWorkerCost).toEqual(zeroDynamicWorkerCost)
	expect(data?.costVsPay).toEqual({
		...zeroDynamicWorkerCost,
		estimatedPaidUsdCents: 0,
		estimatedMarginUsd: 0,
		underwater: false,
		paidSource: 'none',
		risk: 'none',
	})
	expect(data?.durableObjectDuration).toEqual({
		gbSeconds: 0,
		durationMs: 0,
		rpcCount: 0,
		memoryGb: 0.128,
		measured: {
			activeMs: 0,
			gbSeconds: 0,
			estimatedUsd: 0,
			lastDay: null,
			byClass: [],
		},
	})
})

test('loadAdminUserUsageData surfaces caughtCount beside errorCount for package_static_call', async () => {
	const { load } = await setupUsageUser({
		plan: 'standard',
		rollups: [
			[
				'package_static_call',
				'2026-07',
				100,
				{ error_count: 2, caught_count: 7 },
			],
		],
	})
	const data = await load()
	const staticCall = data?.currentMonthUsage.find(
		(row) => row.metric === 'package_static_call',
	)
	expect(staticCall).toEqual(
		expect.objectContaining({
			metric: 'package_static_call',
			eventCount: 100,
			errorCount: 2,
			caughtCount: 7,
		}),
	)
	// Historical / missing caught_count columns read as zero.
	expect(
		data?.currentMonthUsage.find((row) => row.metric === 'execute')
			?.caughtCount,
	).toBe(0)
})

test('loadAdminUserUsageData estimates Dynamic Worker cost from unique worker-days and compares it to catalog MRR', async () => {
	const unpaid = await (
		await setupUsageUser({
			plan: 'pro',
			rollups: [['dynamic_worker_day', '2026-07', 150]],
		})
	).load()
	expect(getEventCount(unpaid?.currentMonthUsage, 'dynamic_worker_day')).toBe(
		150,
	)
	expect(unpaid?.dynamicWorkerCost).toEqual({
		uniqueWorkerDays: 150,
		estimatedGrossUsd: 0.3,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 2_000,
	})
	expect(unpaid?.costVsPay).toMatchObject({
		underwater: false,
		estimatedPaidUsdCents: 0,
		risk: 'none',
	})
	expect(unpaid?.durableObjectDuration.rpcCount).toBe(0)

	const paid = await (
		await setupUsageUser({
			plan: 'free',
			stripe: {
				stripe_plan: 'standard',
				stripe_price_id: 'price_1U3sg6LAQpAnsYszGeL2nc8O',
			},
			rollups: [['dynamic_worker_day', '2026-07', 90]],
		})
	).load()
	expect(paid?.costVsPay).toMatchObject({
		uniqueWorkerDays: 90,
		estimatedPaidUsdCents: 1_200,
		underwater: false,
		paidSource: 'stripe_catalog',
		risk: 'none',
	})
	expect(paid?.costVsPay.estimatedGrossUsd).toBeCloseTo(0.18)
	expect(paid?.costVsPay.estimatedMarginUsd).toBeCloseTo(11.82)
})

test('loadAdminUserUsageData converts Durable Object RPC duration to observe-only GB-s', async () => {
	const { load } = await setupUsageUser({
		plan: 'pro',
		rollups: [
			[
				'durable_object_gb_seconds',
				'2026-07',
				8,
				{ total_duration_ms: 10_000 },
			],
		],
	})
	const data = await load()

	expect(
		getEventCount(data?.currentMonthUsage, 'durable_object_gb_seconds'),
	).toBe(8)
	expect(data?.durableObjectDuration).toEqual({
		gbSeconds: 1.28,
		durationMs: 10_000,
		rpcCount: 8,
		memoryGb: 0.128,
		measured: {
			activeMs: 0,
			gbSeconds: 0,
			estimatedUsd: 0,
			lastDay: null,
			byClass: [],
		},
	})
})

test('loadAdminUserUsageData reads owner-keyed rollups by personal org id when distinct', async () => {
	const distinctOrgId = testStableUserIdFromEmail(
		`distinct-org-${crypto.randomUUID()}@example.com`,
	)
	const { personId, usageUserId, load } = await setupUsageUser({
		plan: 'standard',
		distinctPersonalOrgId: distinctOrgId,
		rollups: [['job_run', '2026-07', 4]],
	})
	expect(personId).not.toBe(usageUserId)
	const data = await load()
	expect(data?.stableUserId).toBe(personId)
	expect(getEventCount(data?.currentMonthUsage, 'job_run')).toBe(4)
})

test('loadAdminUserUsageData warns above eighty percent of plan limits', async () => {
	const { personId, load } = await setupUsageUser({
		plan: 'standard',
		rollups: [
			['job_run', '2026-07', 4],
			['job_run', '2026-06', 40],
		],
		resourceCounts: { saved_packages: 85, scheduled_jobs: 8, secrets: 7 },
		meter: { email_sends_per_day: 170 },
	})
	const data = await load()

	expect(data?.stableUserId).toBe(personId)
	expect(getEventCount(data?.currentMonthUsage, 'job_run')).toBe(4)
	expect(data?.dynamicWorkerCost.uniqueWorkerDays).toBe(0)
	expect(data?.monthUsage.map((month) => month.month)).toEqual([
		'2026-07',
		'2026-06',
	])
	expect(data?.warnings.map((warning) => warning.resource)).toEqual([
		'saved_packages',
		'email_sends_per_day',
	])
})

test('loadAdminUserUsageData rejects an invalid stored plan', async () => {
	const { load } = await setupUsageUser({
		plan: 'enterprise-2099',
		resourceCounts: { stored_email_messages: 12 },
	})
	await expect(load()).rejects.toThrow(
		'Stored plan is not a registered plan name.',
	)
})

test('loadAdminUserUsageData caches rollup reads in KV and serves repeat loads from cache', async () => {
	let rollupQueryCount = 0
	const store = new Map<string, string>()
	const kv = {
		async get(key: string) {
			const raw = store.get(key)
			return raw === undefined ? null : JSON.parse(raw)
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
	}
	const { load } = await setupUsageUser({
		plan: 'max',
		rollups: [['execute', '2026-07', 7]],
		extraEnv: { BUNDLE_ARTIFACTS_KV: kv },
		wrapDb: (db) =>
			({
				prepare(query: string) {
					if (normalizeQuery(query).includes('from usage_rollups')) {
						rollupQueryCount += 1
					}
					return db.prepare(query)
				},
			}) as unknown as D1Database,
	})

	const first = await load()
	expect(getEventCount(first?.currentMonthUsage, 'execute')).toBe(7)
	const queriesAfterFirstLoad = rollupQueryCount
	expect(queriesAfterFirstLoad).toBeGreaterThan(0)
	expect(store.size).toBeGreaterThan(0)
	expect(
		[...store.keys()].filter(
			(key) => !key.startsWith('derived-cache:v1:usage-rollups:'),
		),
	).toEqual([])

	const second = await load()
	expect(getEventCount(second?.currentMonthUsage, 'execute')).toBe(7)
	expect(second?.monthUsage[0]?.month).toBe('2026-07')
	// The repeat load is served from KV: no additional rollup queries.
	expect(rollupQueryCount).toBe(queriesAfterFirstLoad)
})

test('loadAdminUserUsageData keeps current-month and month-over-month rollups on UTC month boundaries', async () => {
	const { load } = await setupUsageUser({
		plan: 'max',
		rollups: [
			['execute', '2026-06', 12],
			['execute', '2026-07', 2],
		],
	})
	const data = await load(new Date('2026-07-01T00:00:00.000Z'))

	expect(getEventCount(data?.currentMonthUsage, 'execute')).toBe(2)
	expect(data?.monthUsage.map((month) => month.month)).toEqual([
		'2026-07',
		'2026-06',
	])
	expect(getEventCount(data?.monthUsage[0]?.usage, 'execute')).toBe(2)
	expect(getEventCount(data?.monthUsage[1]?.usage, 'execute')).toBe(12)
})

test('loadAdminUserUsageData reads daily counts from UserMeter (seeded then warm)', async () => {
	const consumption = async (setup: ReturnType<typeof setupUsageUser>) =>
		Object.fromEntries(
			((await (await setup).load())?.entitlementConsumption ?? []).map(
				(row) => [row.resource, row.current],
			),
		)

	expect(
		await consumption(
			setupUsageUser({
				plan: 'pro',
				resourceCounts: { secrets: 3 },
				meter: { email_receives_per_day: 55, outbound_fetches_per_day: 66 },
			}),
		),
	).toMatchObject({
		email_receives_per_day: 55,
		outbound_fetches_per_day: 66,
		secrets: 3,
	})

	const warm = await setupUsageUser({
		plan: 'pro',
		resourceCounts: { saved_packages: 6, stored_email_messages: 9 },
		meter: {
			email_sends_per_day: 111,
			email_receives_per_day: 222,
			execute_unique_workers_per_day: 333,
			outbound_fetches_per_day: 444,
		},
	})
	warm.env.runLog.setActiveWorkflowCount(warm.usageUserId, 2)
	expect(await consumption(Promise.resolve(warm))).toMatchObject({
		email_sends_per_day: 111,
		email_receives_per_day: 222,
		execute_unique_workers_per_day: 333,
		outbound_fetches_per_day: 444,
		saved_packages: 6,
		stored_email_messages: 9,
		concurrent_workflows: 2,
	})
})

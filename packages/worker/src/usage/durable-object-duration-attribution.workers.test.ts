import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test, vi, type Mock } from 'vitest'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { repoSessionStorageBucketId } from '#worker/storage-buckets/service.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensurePackageSubscriptionTestSchema } from '#worker/test-support/workers-seed.ts'
import {
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'
import {
	buildDurableObjectOwnerMap,
	runDurableObjectDurationAttribution,
} from './durable-object-duration-attribution.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const credentialedEnv = {
	...env,
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
}

function stubFetch<T extends Mock>(fetchMock: T) {
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

function analyticsResponse(
	groups: Array<[objectId: string, activeTime: number]>,
) {
	return new Response(
		JSON.stringify({
			data: {
				viewer: {
					accounts: [
						{
							durableObjectsPeriodicGroups: groups.map(
								([objectId, activeTime]) => ({
									dimensions: { objectId },
									sum: { activeTime },
								}),
							),
						},
					],
				},
			},
		}),
	)
}

async function ensureSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await env.APP_DB.batch([
		env.APP_DB
			.prepare(`CREATE TABLE IF NOT EXISTS durable_object_duration_daily (
	user_id TEXT NOT NULL,
	do_class TEXT NOT NULL,
	day TEXT NOT NULL,
	active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, do_class, day)
)`),
		env.APP_DB
			.prepare(`CREATE TABLE IF NOT EXISTS durable_object_duration_coverage_daily (
	day TEXT PRIMARY KEY,
	total_active_ms INTEGER NOT NULL,
	attributed_active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	attributed_object_count INTEGER NOT NULL,
	truncated INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
)`),
	])
}

async function seedUser() {
	const email = `do-duration-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'hash', ?)`,
	)
		.bind(`dod-${crypto.randomUUID().slice(0, 8)}`, email, userId)
		.run()
	return userId
}

async function seedTeamOrg(input?: { deletedAt?: string | null }) {
	const orgId = testStableUserIdFromEmail(
		`do-duration-org-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, deleted_at, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?, ?)`,
	)
		.bind(
			orgId,
			`org${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
			input?.deletedAt ?? null,
			now,
			now,
		)
		.run()
	return orgId
}

test('owner map object ids match the ids the Durable Objects themselves see', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const storageId = `package:${crypto.randomUUID()}`
	const repoSessionId = crypto.randomUUID()
	const now = new Date().toISOString()
	for (const [bucketId, kind] of [
		[storageId, 'package'],
		[repoSessionStorageBucketId(repoSessionId), 'repo_session'],
	]) {
		await env.APP_DB.prepare(
			`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(userId, bucketId, kind, now, now)
			.run()
	}

	const owners = await buildDurableObjectOwnerMap(env)
	const runLog = env.RUN_LOG.get(
		env.RUN_LOG.idFromName(runLogDurableObjectName(ownerIdFromStored(userId))),
	)
	await runInDurableObject(runLog, (_instance, state) => {
		expect(owners.get(state.id.toString())).toEqual({
			userId,
			doClass: 'RunLog',
		})
	})
	const storage = env.STORAGE_RUNNER.get(
		env.STORAGE_RUNNER.idFromName(
			storageRunnerDurableObjectName(ownerIdFromStored(userId), storageId),
		),
	)
	await runInDurableObject(storage, (_instance, state) => {
		expect(owners.get(state.id.toString())).toEqual({
			userId,
			doClass: 'StorageRunner',
		})
	})
	expect(
		owners.get(env.REPO_SESSION.idFromName(repoSessionId).toString()),
	).toEqual({ userId, doClass: 'RepoSession' })
})

test('the lane stores attributed daily active time and fleet coverage', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const hubId = env.MCP_CLIENT_HUB.idFromName(userId).toString()
	using _fetch = stubFetch(
		vi.fn(async (_url: string, init: RequestInit) => {
			const { variables } = JSON.parse(String(init.body)) as {
				variables: { day: string }
			}
			return analyticsResponse(
				variables.day === '2026-09-26'
					? [
							[hubId, 7_200_000_000],
							['f'.repeat(64), 800_000_000],
						]
					: [],
			)
		}),
	)
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	// Rerunning the same hour overwrites instead of adding.
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T04:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT do_class, active_ms, object_count FROM durable_object_duration_daily
			 WHERE user_id = ? AND day = '2026-09-26'`,
		)
			.bind(userId)
			.all(),
	).toMatchObject({
		results: [
			{ do_class: 'McpClientHub', active_ms: 7_200_000, object_count: 1 },
		],
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT total_active_ms, attributed_active_ms, object_count, attributed_object_count
			 FROM durable_object_duration_coverage_daily WHERE day = '2026-09-26'`,
		).first(),
	).toEqual({
		total_active_ms: 8_000_000,
		attributed_active_ms: 7_200_000,
		object_count: 2,
		attributed_object_count: 1,
	})
})

test('a user whose deletion starts mid-run gets no duration rows', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const hubId = env.MCP_CLIENT_HUB.idFromName(userId).toString()
	using _fetch = stubFetch(
		vi.fn(async () => {
			await env.APP_DB.prepare(
				`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
			)
				.bind(new Date().toISOString(), userId)
				.run()
			return analyticsResponse([[hubId, 1_000_000]])
		}),
	)
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM durable_object_duration_daily WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toEqual({ count: 0 })
})

test('a live team org with no users row keeps duration rows', async () => {
	await ensureSchema()
	const orgId = await seedTeamOrg()
	const hubId = env.MCP_CLIENT_HUB.idFromName(orgId).toString()
	using _fetch = stubFetch(
		vi.fn(async () => analyticsResponse([[hubId, 3_000_000]])),
	)
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT do_class, active_ms FROM durable_object_duration_daily
			 WHERE user_id = ? AND day = '2026-09-26'`,
		)
			.bind(orgId)
			.all(),
	).toMatchObject({
		results: [{ do_class: 'McpClientHub', active_ms: 3_000 }],
	})
})

test('a soft-deleted team org gets no duration rows', async () => {
	await ensureSchema()
	const orgId = await seedTeamOrg({ deletedAt: '2026-09-01T00:00:00.000Z' })
	const storageId = `package:${crypto.randomUUID()}`
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'package', ?, ?)`,
	)
		.bind(orgId, storageId, now, now)
		.run()
	const storageObjectId = env.STORAGE_RUNNER.idFromName(
		storageRunnerDurableObjectName(ownerIdFromStored(orgId), storageId),
	).toString()
	using _fetch = stubFetch(
		vi.fn(async () => analyticsResponse([[storageObjectId, 3_000_000]])),
	)
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM durable_object_duration_daily WHERE user_id = ?`,
		)
			.bind(orgId)
			.first(),
	).toEqual({ count: 0 })
})

test('reruns upsert changed rows, keep unchanged ones, and drop stale ones', async () => {
	await ensureSchema()
	const users = await Promise.all(Array.from({ length: 30 }, () => seedUser()))
	const hubIds = users.map((userId) =>
		env.MCP_CLIENT_HUB.idFromName(userId).toString(),
	)
	let groups: Array<[string, number]> = hubIds.map((id) => [id, 1_000_000])
	using _fetch = stubFetch(
		vi.fn(async (_url: string, init: RequestInit) => {
			const { variables } = JSON.parse(String(init.body)) as {
				variables: { day: string }
			}
			return analyticsResponse(variables.day === '2026-09-26' ? groups : [])
		}),
	)
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
		batchPauseMs: 0,
	})
	// User 0 grows, user 1 drops out of the analytics, the rest are unchanged.
	groups = [
		[hubIds[0]!, 4_000_000],
		...hubIds.slice(2).map((id): [string, number] => [id, 1_000_000]),
	]
	await runDurableObjectDurationAttribution({
		env: credentialedEnv,
		now: new Date('2026-09-27T04:20:00.000Z'),
		batchPauseMs: 0,
	})
	const rows = await env.APP_DB.prepare(
		`SELECT user_id, active_ms, updated_at FROM durable_object_duration_daily
		 WHERE day = '2026-09-26' AND do_class = 'McpClientHub'`,
	).all<{ user_id: string; active_ms: number; updated_at: string }>()
	const byUser = new Map(rows.results.map((row) => [row.user_id, row]))
	expect(byUser.get(users[0]!)).toMatchObject({
		active_ms: 4_000,
		updated_at: '2026-09-27T04:20:00.000Z',
	})
	expect(byUser.has(users[1]!)).toBe(false)
	for (const userId of users.slice(2)) {
		expect(byUser.get(userId)).toMatchObject({
			active_ms: 1_000,
			updated_at: '2026-09-27T03:20:00.000Z',
		})
	}
})

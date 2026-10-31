import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { followRecentUpdatesPerFollow } from '#universal/follows.ts'
import { mergeFollowPushWindow } from './coalesce.ts'
import { deliverFollowRecords, type FollowDeliveryHooks } from './deliver.ts'
import { runFollowMaintenance } from './maintenance.ts'
import {
	deleteFollowForOrg,
	ensureFollowTables,
	getFollowByTarget,
	insertFollow,
	insertFollowRecentUpdate,
	listFollowRecentUpdates,
} from './repo.ts'
import { type FollowPushPending, type FollowRecord } from './types.ts'

const orgA = 'org-a'
const orgB = 'org-b'
const now = new Date('2026-10-15T12:00:00.000Z')

const target = {
	kind: 'package' as const,
	ownerId: 'org-owner',
	id: 'pkg-1',
	name: '@ada/notes',
	isPrivate: false,
}

function record(id: string, followerOrgId: string): FollowRecord {
	return {
		id,
		followerOrgId,
		creatorUserId: `user-${followerOrgId}`,
		creatorProfileId: null,
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		status: 'active',
		pausedAt: null,
		pausedReason: null,
		publishedEnabled: true,
		pushedEnabled: true,
		lastDeliverySkipReason: null,
		lastDeliverySkipAt: null,
		createdAt: '2026-10-15T00:00:00.000Z',
		updatedAt: '2026-10-15T00:00:00.000Z',
	}
}

async function seed() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	for (const [id, org] of [
		['follow-a', orgA],
		['follow-b', orgB],
	] as const) {
		await insertFollow(db, {
			id,
			followerOrgId: org,
			creatorUserId: `user-${org}`,
			targetKind: 'package',
			targetOwnerId: 'org-owner',
			targetId: 'pkg-1',
			targetName: '@ada/notes',
			createdAt: '2026-10-15T00:00:00.000Z',
		})
	}
	return db
}

const subscriber = {
	savedPackage: { id: 'subscriber-1', userId: orgA } as SavedPackageRecord,
	subscription: {
		topic: 'follow.published',
		handler: './src/on-follow.ts',
		description: null,
		filters: null,
	},
}

function hooks(overrides: Partial<FollowDeliveryHooks> = {}) {
	return {
		loadTarget: async () => target,
		resolveAccess: async () => ({ canCreate: true, canPush: true }),
		loadSubscriptions: async () => [],
		invoke: vi.fn(async () => ({ status: 200, body: { ok: true } })),
		...overrides,
	} satisfies FollowDeliveryHooks
}

const published = {
	previousCommit: 'old0000',
	publishedCommit: 'new1234567890',
	publishedAt: '2026-10-15T11:59:00.000Z',
}

async function deliverPublished(
	db: D1Database,
	deliveryHooks: FollowDeliveryHooks,
	follows = [record('follow-a', orgA)],
) {
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows,
		now,
		published,
		hooks: deliveryHooks,
	})
}

test('an event no package handles is stored as a recent update', async () => {
	const db = await seed()
	await deliverPublished(db, hooks())
	const updates = await listFollowRecentUpdates(db, {
		followerOrgId: orgA,
		limit: 10,
	})
	expect(updates).toEqual([
		{
			id: expect.any(String),
			followId: 'follow-a',
			targetName: '@ada/notes',
			targetKind: 'package',
			occurredAt: published.publishedAt,
			detail: {
				event: 'published',
				publishedCommit: published.publishedCommit,
				previousCommit: published.previousCommit,
			},
		},
	])
})

test('a handled event keeps today’s delivery and stores no recent update', async () => {
	const db = await seed()
	const deliveryHooks = hooks({ loadSubscriptions: async () => [subscriber] })
	await deliverPublished(db, deliveryHooks)
	expect(deliveryHooks.invoke).toHaveBeenCalledTimes(1)
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toEqual([])
})

test('a subscription with no on enablement counts as unhandled', async () => {
	const db = await seed()
	await deliverPublished(
		db,
		hooks({
			loadSubscriptions: async () => [subscriber],
			invoke: vi.fn(async () => ({
				status: 202,
				body: { ok: true, skipped: { reason: 'no_enablement_on' } },
			})),
		}),
	)
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toHaveLength(1)
})

test('zero credits and failed handlers store no recent update', async () => {
	silenceExpectedConsoleErrors([
		'follow-subscription-invoke-failed',
		'follow-subscription-discovery-failed',
	])
	const db = await seed()
	await deliverPublished(
		db,
		hooks({
			loadSubscriptions: async () => [subscriber],
			invoke: vi.fn(async () => ({ status: 429, body: {} })),
		}),
	)
	await deliverPublished(
		db,
		hooks({
			loadSubscriptions: async () => [subscriber],
			invoke: vi.fn(async () => {
				throw new Error('handler crashed')
			}),
		}),
	)
	await deliverPublished(
		db,
		hooks({
			loadSubscriptions: async () => {
				throw new Error('discovery failed')
			},
		}),
	)
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toEqual([])
	const row = await getFollowByTarget(db, {
		followerOrgId: orgA,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.lastDeliverySkipReason).toBe('zero_credits')
})

test('incomplete discovery and filtered-out handlers store no recent update', async () => {
	silenceExpectedConsoleErrors(['follow-subscription-discovery-incomplete'])
	const db = await seed()
	const incomplete = hooks({
		loadSubscriptions: async () => ({
			subscriptions: [],
			discoveryErrors: [new Error('manifest unavailable')],
		}),
	})
	await deliverPublished(db, incomplete)
	const filtered = hooks({
		loadSubscriptions: async () => [
			{
				...subscriber,
				subscription: {
					...subscriber.subscription,
					filters: { name: '@someone/else' },
				},
			},
		],
	})
	await deliverPublished(db, filtered)
	expect(filtered.invoke).not.toHaveBeenCalled()
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toEqual([])
})

test('lost access pauses the follow and records nothing', async () => {
	const db = await seed()
	const loadSubscriptions = vi.fn(async () => [])
	await deliverPublished(
		db,
		hooks({
			resolveAccess: async () => ({ canCreate: false, canPush: false }),
			loadSubscriptions,
		}),
	)
	await deliverPublished(db, hooks({ loadTarget: async () => null }), [
		record('follow-b', orgB),
	])
	expect(loadSubscriptions).not.toHaveBeenCalled()
	for (const org of [orgA, orgB]) {
		expect(
			await listFollowRecentUpdates(db, { followerOrgId: org, limit: 10 }),
		).toEqual([])
		const row = await getFollowByTarget(db, {
			followerOrgId: org,
			targetKind: 'package',
			targetId: 'pkg-1',
		})
		expect(row?.status).toBe('paused')
	}
})

test('a push the follower cannot read is not recorded', async () => {
	const db = await seed()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [record('follow-a', orgA)],
		now,
		pushed: pushWindow(),
		hooks: hooks({
			resolveAccess: async () => ({ canCreate: true, canPush: false }),
		}),
	})
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toEqual([])
})

test('recent updates stay inside the follower org', async () => {
	const db = await seed()
	await deliverPublished(db, hooks())
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgB, limit: 10 }),
	).toEqual([])
	expect(
		await listFollowRecentUpdates(db, {
			followerOrgId: orgB,
			followId: 'follow-a',
			limit: 10,
		}),
	).toEqual([])
	// A row claiming another org's follow is never stored.
	expect(
		await insertFollowRecentUpdate(db, {
			id: 'forged',
			followerOrgId: orgB,
			followId: 'follow-a',
			dedupeKey: 'published:x',
			detail: {
				event: 'published',
				publishedCommit: 'x',
				previousCommit: null,
			},
			occurredAt: now.toISOString(),
			createdAt: now.toISOString(),
		}),
	).toBe(false)
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toHaveLength(1)
	// Org B unfollowing by id cannot remove org A's updates.
	await deleteFollowForOrg(db, { followerOrgId: orgB, id: 'follow-a' })
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgA, limit: 10 }),
	).toHaveLength(1)
})

test('each follow keeps only its newest recent updates', async () => {
	const db = await seed()
	const extra = 5
	for (let index = 0; index < followRecentUpdatesPerFollow + extra; index++) {
		const at = new Date(now.getTime() + index * 1000).toISOString()
		await insertFollowRecentUpdate(db, {
			id: `update-${index}`,
			followerOrgId: orgA,
			followId: 'follow-a',
			dedupeKey: `published:${index}`,
			detail: {
				event: 'published',
				publishedCommit: `commit-${index}`,
				previousCommit: null,
			},
			occurredAt: at,
			createdAt: at,
		})
	}
	await insertFollowRecentUpdate(db, {
		id: 'update-b',
		followerOrgId: orgB,
		followId: 'follow-b',
		dedupeKey: 'published:b',
		detail: { event: 'published', publishedCommit: 'b', previousCommit: null },
		occurredAt: now.toISOString(),
		createdAt: now.toISOString(),
	})
	const kept = await listFollowRecentUpdates(db, {
		followerOrgId: orgA,
		limit: 100,
	})
	expect(kept).toHaveLength(followRecentUpdatesPerFollow)
	expect(kept[0]?.id).toBe(`update-${followRecentUpdatesPerFollow + extra - 1}`)
	expect(kept.at(-1)?.id).toBe(`update-${extra}`)
	expect(
		await listFollowRecentUpdates(db, { followerOrgId: orgB, limit: 100 }),
	).toHaveLength(1)
})

test('maintenance drops expired updates and updates of deleted follows', async () => {
	const db = await seed()
	const old = '2026-09-01T00:00:00.000Z'
	await insertFollowRecentUpdate(db, {
		id: 'expired',
		followerOrgId: orgA,
		followId: 'follow-a',
		dedupeKey: 'published:old',
		detail: {
			event: 'published',
			publishedCommit: 'old',
			previousCommit: null,
		},
		occurredAt: old,
		createdAt: old,
	})
	await insertFollowRecentUpdate(db, {
		id: 'fresh',
		followerOrgId: orgA,
		followId: 'follow-a',
		dedupeKey: 'published:new',
		detail: {
			event: 'published',
			publishedCommit: 'new',
			previousCommit: null,
		},
		occurredAt: now.toISOString(),
		createdAt: now.toISOString(),
	})
	await insertFollowRecentUpdate(db, {
		id: 'orphan',
		followerOrgId: orgB,
		followId: 'follow-b',
		dedupeKey: 'published:b',
		detail: { event: 'published', publishedCommit: 'b', previousCommit: null },
		occurredAt: now.toISOString(),
		createdAt: now.toISOString(),
	})
	await db.prepare(`DELETE FROM follows WHERE id = 'follow-b'`).run()
	const result = await runFollowMaintenance({
		env: { APP_DB: db } as Env,
		now,
	})
	expect(result.recentUpdatesDeleted).toBe(2)
	const remaining = await db
		.prepare(`SELECT id FROM follow_recent_updates ORDER BY id`)
		.all<{ id: string }>()
	expect(remaining.results.map((row) => row.id)).toEqual(['fresh'])
})

function pushWindow(): FollowPushPending {
	const pushes = [1, 2, 3].map((index) => ({
		before: `c${index - 1}`,
		after: `c${index}`,
		ref: 'refs/heads/main',
		commits: [
			{
				id: `c${index}`,
				message: `Commit ${index}\n\nbody`,
				message_truncated: false,
				timestamp: `2026-10-15T11:5${index}:00.000Z`,
				author: { name: 'Ada', email: 'ada@example.com' },
				committer: { name: 'Ada', email: 'ada@example.com' },
				parents: [`c${index - 1}`],
			},
		],
		totalCommitsCount: 1,
		at: `2026-10-15T11:5${index}:00.000Z`,
	}))
	let pending: FollowPushPending | null = null
	for (const incoming of pushes) {
		const merged = mergeFollowPushWindow({
			targetKind: 'package',
			targetId: 'pkg-1',
			existing: pending,
			incoming,
			now: new Date(incoming.at),
		})
		pending = merged.pending
	}
	if (!pending) throw new Error('expected a push window')
	return pending
}

test('a coalesced push window is one recent update, even when flushed twice', async () => {
	const db = await seed()
	const pending = pushWindow()
	expect(pending.totalCommitsCount).toBe(3)
	for (let attempt = 0; attempt < 2; attempt++) {
		await deliverFollowRecords({
			env: { APP_DB: db } as Env,
			follows: [record('follow-a', orgA)],
			now,
			pushed: pending,
			hooks: hooks(),
		})
	}
	const updates = await listFollowRecentUpdates(db, {
		followerOrgId: orgA,
		limit: 10,
	})
	expect(updates).toHaveLength(1)
	expect(updates[0]?.detail).toEqual({
		event: 'pushed',
		ref: 'refs/heads/main',
		afterCommit: 'c3',
		totalCommits: 3,
		latestMessage: 'Commit 3\n\nbody',
	})
})

import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type CommunityForkRecord } from '#worker/community/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { deliverFollowRecords, deliverListingForkAliases } from './deliver.ts'
import { ensureFollowTables, getFollowByTarget, insertFollow } from './repo.ts'
import { type FollowPushPending, type FollowRecord } from './types.ts'

const aliasMocks = vi.hoisted(() => ({
	listCommunityForksByListingId: vi.fn(),
	getActiveCommunityListingWithPublisherUsername: vi.fn(),
	deliverCommunityForkUpstreamUpdatedAlias: vi.fn(
		async (_input: {
			alias: {
				eventId: string
				fork: { id: string }
				previous: { pinnedCommit: string; packageVersion: string | null }
				current: { pinnedCommit: string; packageVersion: string | null }
			}
		}) => 'delivered' as const,
	),
}))

vi.mock('#worker/community/repo.ts', () => ({
	listCommunityForksByListingId: aliasMocks.listCommunityForksByListingId,
	getActiveCommunityListingWithPublisherUsername:
		aliasMocks.getActiveCommunityListingWithPublisherUsername,
}))

vi.mock(
	'#worker/community/fork-upstream-updated-package-subscriptions.ts',
	() => ({
		deliverCommunityForkUpstreamUpdatedAlias:
			aliasMocks.deliverCommunityForkUpstreamUpdatedAlias,
	}),
)

const followerOrgId = 'org-follower'
const now = new Date('2026-10-15T12:00:00.000Z')
const opaquePackageId = '11111111-2222-4333-8444-555555555555'

function follow(overrides: Partial<FollowRecord> = {}): FollowRecord {
	return {
		id: 'follow-1',
		followerOrgId,
		creatorUserId: 'user-1',
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
		...overrides,
	}
}

const target = {
	kind: 'package' as const,
	ownerId: 'org-owner',
	id: 'pkg-1',
	name: '@ada/notes',
	isPrivate: true,
}

const pending: FollowPushPending = {
	targetKind: 'package',
	targetId: 'pkg-1',
	windowStartedAt: '2026-10-15T11:50:00.000Z',
	beforeCommit: 'before',
	afterCommit: 'after',
	ref: 'refs/heads/main',
	commits: [],
	totalCommitsCount: 1,
	updatedAt: '2026-10-15T11:54:00.000Z',
	revision: 0,
	generation: '',
}

async function seed() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-1',
		followerOrgId,
		creatorUserId: 'user-1',
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	return db
}

test('delivery pauses a follow when create-level access is gone', async () => {
	const db = await seed()
	const invoke = vi.fn()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow()],
		now,
		published: {
			previousCommit: 'old',
			publishedCommit: 'new',
			publishedAt: now.toISOString(),
		},
		hooks: {
			loadTarget: async () => target,
			resolveAccess: async () => ({ canCreate: false, canPush: false }),
			invoke,
		},
	})
	expect(invoke).not.toHaveBeenCalled()
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('paused')
	expect(row?.pausedAt).toBe(now.toISOString())
	expect(row?.pausedReason).toBe('access_lost')
})

test('delivery pauses with target_missing when the target is gone', async () => {
	const db = await seed()
	const invoke = vi.fn()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow()],
		now,
		pushed: pending,
		hooks: { loadTarget: async () => null, invoke },
	})
	expect(invoke).not.toHaveBeenCalled()
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('paused')
	expect(row?.pausedReason).toBe('target_missing')
})

test('a follow only delivers the events it chose', async () => {
	const db = await seed()
	const loadSubscriptions = vi.fn(async () => [])
	const loadTarget = vi.fn(async () => ({ ...target, isPrivate: false }))
	const hooks = {
		loadTarget,
		resolveAccess: async () => ({ canCreate: true, canPush: true }),
		loadSubscriptions,
	}
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow({ pushedEnabled: false })],
		now,
		pushed: pending,
		hooks,
	})
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow({ publishedEnabled: false })],
		now,
		published: {
			previousCommit: 'old',
			publishedCommit: 'new',
			publishedAt: now.toISOString(),
		},
		hooks,
	})
	expect(loadTarget).not.toHaveBeenCalled()
	expect(loadSubscriptions).not.toHaveBeenCalled()

	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow({ publishedEnabled: false })],
		now,
		pushed: pending,
		hooks,
	})
	expect(loadSubscriptions).toHaveBeenCalledWith(
		expect.objectContaining({ topic: 'follow.pushed' }),
	)
})

test('push delivery without package:read skips and does not pause', async () => {
	const db = await seed()
	const invoke = vi.fn()
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [follow()],
		now,
		pushed: pending,
		hooks: {
			loadTarget: async () => target,
			resolveAccess: async () => ({ canCreate: true, canPush: false }),
			invoke,
		},
	})
	expect(invoke).not.toHaveBeenCalled()
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('active')
	expect(row?.pausedAt).toBeNull()
})

test('a 429 invocation is stored on the follow and does not throw', async () => {
	const db = await seed()
	const invoke = vi.fn(async () => ({
		status: 429,
		body: { error: { code: 'entitlement_limit_exceeded' } },
	}))
	await expect(
		deliverFollowRecords({
			env: { APP_DB: db } as Env,
			follows: [follow()],
			now,
			published: {
				previousCommit: 'old',
				publishedCommit: 'new',
				publishedAt: now.toISOString(),
			},
			hooks: {
				loadTarget: async () => ({ ...target, isPrivate: false }),
				resolveAccess: async () => ({ canCreate: true, canPush: true }),
				loadSubscriptions: async () => [
					{
						savedPackage: { id: 'subscriber-1' } as SavedPackageRecord,
						subscription: {
							topic: 'follow.published',
							handler: './src/on-follow.ts',
							description: null,
							filters: null,
						},
					},
				],
				invoke,
			},
		}),
	).resolves.toBeUndefined()
	expect(invoke).toHaveBeenCalledTimes(1)
	const row = await getFollowByTarget(db, {
		followerOrgId,
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(row?.status).toBe('active')
	expect(row?.lastDeliverySkipReason).toBe('zero_credits')
	expect(row?.lastDeliverySkipAt).toBe(now.toISOString())
})

test('published event_id is opaque and idempotency keeps internal ids', async () => {
	const db = await seed()
	const followId = 'follow-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
	const invoke = vi.fn(async () => ({ status: 200, body: {} }))
	await deliverFollowRecords({
		env: { APP_DB: db } as Env,
		follows: [
			follow({
				id: followId,
				targetId: opaquePackageId,
			}),
		],
		now,
		published: {
			previousCommit: 'old',
			publishedCommit: 'new',
			publishedAt: now.toISOString(),
		},
		hooks: {
			loadTarget: async () => ({
				...target,
				id: opaquePackageId,
			}),
			resolveAccess: async () => ({ canCreate: true, canPush: true }),
			loadSubscriptions: async () => [
				{
					savedPackage: { id: 'subscriber-1' } as SavedPackageRecord,
					subscription: {
						topic: 'follow.published',
						handler: './src/on-follow.ts',
						description: null,
						filters: null,
					},
				},
			],
			invoke,
		},
	})
	const calls = invoke.mock.calls as unknown as Array<
		[{ idempotencyKey: string; params: { event_id: string } }]
	>
	const call = calls[0]?.[0]
	expect(call).toBeDefined()
	if (!call) return
	expect(call.params.event_id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
	)
	expect(call.params.event_id).not.toContain(opaquePackageId)
	expect(call.params.event_id).not.toContain(followId)
	expect(call.idempotencyKey).toBe(
		`follow-published:${followId}:new:subscriber-1`,
	)
})

function forkRecord(
	overrides: Partial<CommunityForkRecord> = {},
): CommunityForkRecord {
	return {
		id: 'fork-1',
		listingId: 'listing-1',
		upstreamOwnerId: null,
		upstreamPackageId: null,
		forkerUserId: 'person-a',
		originCommit: 'old',
		forkedPackageId: opaquePackageId,
		forkedSourceId: 'source-fork',
		targetKodyId: 'notes',
		createdAt: '2026-10-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
		...overrides,
	}
}

test('a listing pin move aliases every fork still behind the pin', async () => {
	aliasMocks.deliverCommunityForkUpstreamUpdatedAlias.mockClear()
	aliasMocks.getActiveCommunityListingWithPublisherUsername.mockResolvedValue({
		publisherUsername: 'ada',
		listing: {
			id: 'listing-1',
			name: '@ada/notes',
			kodyId: 'notes',
			description: 'Notes',
			publishedAt: '2026-10-15T00:00:00.000Z',
		},
	})
	aliasMocks.listCommunityForksByListingId.mockResolvedValue([
		forkRecord({
			id: 'fork-behind',
			forkerUserId: 'person-a',
			originCommit: 'old',
		}),
		forkRecord({
			id: 'fork-current',
			forkerUserId: 'org-follower',
			originCommit: 'new',
			forkedPackageId: 'already-current',
		}),
		forkRecord({
			id: 'fork-other-org',
			forkerUserId: 'person-b',
			originCommit: 'older',
			forkedPackageId: 'pkg-b',
		}),
	])
	await deliverListingForkAliases({
		env: {
			APP_DB: {} as D1Database,
			APP_BASE_URL: 'https://kody.test',
		} as Env,
		listingId: 'listing-1',
		previous: { pinnedCommit: 'old', packageVersion: '1.0.0' },
		current: { pinnedCommit: 'new', packageVersion: '2.0.0' },
		publishedAt: now.toISOString(),
	})
	expect(
		aliasMocks.deliverCommunityForkUpstreamUpdatedAlias,
	).toHaveBeenCalledTimes(2)
	const aliases =
		aliasMocks.deliverCommunityForkUpstreamUpdatedAlias.mock.calls.map(
			(call) => call[0].alias,
		)
	expect(aliases.map((alias) => alias.fork.id)).toEqual([
		'fork-behind',
		'fork-other-org',
	])
	for (const alias of aliases) {
		expect(alias.eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
		expect(alias.eventId).not.toContain(opaquePackageId)
		expect(alias.eventId).not.toContain(alias.fork.id)
		expect(alias.previous).toEqual({
			pinnedCommit: 'old',
			packageVersion: '1.0.0',
		})
		expect(alias.current).toEqual({
			pinnedCommit: 'new',
			packageVersion: '2.0.0',
		})
	}
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { resourceGrantKey } from '#worker/authorization/access-compile.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	addFollow,
	consumeFollowCreateSlot,
	FollowNotFoundError,
	FollowRateLimitError,
	removeFollow,
} from './service.ts'
import { followCreateMaxPerHour } from './types.ts'
import {
	ensureFollowTables,
	getFollowByTarget,
	insertFollow,
	pauseFollow,
	retargetFollowCreator,
} from './repo.ts'

const serviceMocks = vi.hoisted(() => ({
	getOrgBySlug: vi.fn(),
	getSavedPackageByName: vi.fn(),
	getUserRepoByName: vi.fn(),
	loadFollowTargetPermissions: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getOrgBySlug: serviceMocks.getOrgBySlug }
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getSavedPackageByName: serviceMocks.getSavedPackageByName,
	}
})

vi.mock('#worker/repo/user-repos.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getUserRepoByName: serviceMocks.getUserRepoByName }
})

vi.mock('./access.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		loadFollowTargetPermissions: serviceMocks.loadFollowTargetPermissions,
	}
})

test('the 31st new follow in an hour is rejected', async () => {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-1')
	}
	await expect(consumeFollowCreateSlot(db, 'org-1')).rejects.toBeInstanceOf(
		FollowRateLimitError,
	)
	await expect(consumeFollowCreateSlot(db, 'org-2')).resolves.toBeUndefined()
})

const ownerId = ownerIdFromStored('org-ada')

function followDb() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	return db
}

function savedPackage(input: { id: string; name: string; isPrivate: boolean }) {
	return {
		userId: ownerId,
		id: input.id,
		name: input.name,
		isPrivate: input.isPrivate,
	}
}

function executeOnlyAccess(packageId: string): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set<OrgPermission>(),
		isOwner: false,
		resourcePermissions: new Map([
			[
				resourceGrantKey('package', packageId),
				new Set<OrgPermission>(['package:execute']),
			],
		]),
		credentialScopes: null,
	}
}

test('execute-only access to a private package is not found', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-private', name: '@ada/notes', isPrivate: true }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(
		executeOnlyAccess('pkg-private'),
	)
	await expect(
		addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-follower',
			creatorUserId: 'person-1',
			name: '@ada/notes',
		}),
	).rejects.toThrow(/not found/)
	expect(
		await getFollowByTarget(db, {
			followerOrgId: 'org-follower',
			targetKind: 'package',
			targetId: 'pkg-private',
		}),
	).toBeNull()
})

test('the 31st new followAdd in an hour is rejected', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			savedPackage({ id: input.name, name: input.name, isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-limited',
			creatorUserId: 'person-1',
			name: `@ada/pkg-${index}`,
		})
	}
	await expect(
		addFollow({
			env: { APP_DB: db } as Env,
			followerOrgId: 'org-limited',
			creatorUserId: 'person-1',
			name: '@ada/pkg-over',
		}),
	).rejects.toBeInstanceOf(FollowRateLimitError)
})

test('followAdd retargets an active follow whose creator was anonymized', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-active',
		followerOrgId: 'org-team',
		creatorUserId: 'deleted-user',
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-private',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-team')
	}
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-private', name: '@ada/notes', isPrivate: true }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue({
		orgId: ownerId,
		permissions: new Set(),
		isOwner: false,
		resourcePermissions: new Map([
			[
				resourceGrantKey('package', 'pkg-private'),
				new Set<OrgPermission>(['package:read', 'package:execute']),
			],
		]),
		credentialScopes: null,
	})
	const viewed = await addFollow({
		env: { APP_DB: db } as Env,
		followerOrgId: 'org-team',
		creatorUserId: 'person-2',
		name: '@ada/notes',
	})
	expect(viewed.status).toBe('active')
	const row = await getFollowByTarget(db, {
		followerOrgId: 'org-team',
		targetKind: 'package',
		targetId: 'pkg-private',
	})
	expect(row?.creatorUserId).toBe('person-2')
	expect(row?.status).toBe('active')
})

test('followAdd that loses a create race still applies the requested events', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	const prepare = db.prepare.bind(db)
	let raced = false
	db.prepare = (sql: string) => {
		if (!raced && sql.trimStart().startsWith('INSERT INTO follows (')) {
			raced = true
			return {
				bind: () => ({
					run: async () => {
						await insertFollow(db, {
							id: 'follow-winner',
							followerOrgId: 'org-race-events',
							creatorUserId: 'person-1',
							targetKind: 'package',
							targetOwnerId: ownerId,
							targetId: 'pkg-notes',
							targetName: '@ada/notes',
							createdAt: '2026-10-15T00:00:00.000Z',
						})
						throw new Error('UNIQUE constraint failed: follows')
					},
				}),
			} as unknown as D1PreparedStatement
		}
		return prepare(sql)
	}
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-notes', name: '@ada/notes', isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)

	const view = await addFollow({
		env: { APP_DB: db } as Env,
		followerOrgId: 'org-race-events',
		creatorUserId: 'person-1',
		name: '@ada/notes',
		events: ['published'],
	})

	expect(raced).toBe(true)
	expect(view.events).toEqual(['published'])
	const stored = await getFollowByTarget(db, {
		followerOrgId: 'org-race-events',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(stored?.id).toBe('follow-winner')
	expect(stored?.pushedEnabled).toBe(false)
})

test('retargetFollowCreator returns false after a concurrent pause', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-race',
		followerOrgId: 'org-race',
		creatorUserId: 'deleted-user',
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-race',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-race',
		pausedAt: '2026-10-15T02:00:00.000Z',
		reason: 'access_lost',
	})
	expect(
		await retargetFollowCreator(db, {
			id: 'follow-race',
			updatedAt: '2026-10-15T02:01:00.000Z',
			creatorUserId: 'person-2',
		}),
	).toBe(false)
})

test('resumeFollow returns false when the follow is already active', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-active-resume',
		followerOrgId: 'org-resume-race',
		creatorUserId: 'person-1',
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-resume-race',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	const { resumeFollow } = await import('./repo.ts')
	expect(
		await resumeFollow(db, {
			id: 'follow-active-resume',
			updatedAt: '2026-10-15T02:01:00.000Z',
			creatorUserId: 'person-2',
		}),
	).toBe(false)
})

test('followAdd resumes a paused follow without consuming a create slot', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-paused',
		followerOrgId: 'org-resume',
		creatorUserId: 'person-1',
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-paused',
		pausedAt: '2026-10-15T01:00:00.000Z',
		reason: 'access_lost',
	})
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-resume')
	}
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-notes', name: '@ada/notes', isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)
	const resumed = await addFollow({
		env: { APP_DB: db } as Env,
		followerOrgId: 'org-resume',
		creatorUserId: 'person-2',
		name: '@ada/notes',
	})
	expect(resumed.status).toBe('active')
	expect(resumed.paused_at).toBeNull()
	const row = await getFollowByTarget(db, {
		followerOrgId: 'org-resume',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(row?.status).toBe('active')
	expect(row?.pausedAt).toBeNull()
	expect(row?.creatorUserId).toBe('person-2')
})

function useGrantAccess(packageId: string): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set<OrgPermission>(),
		isOwner: false,
		resourcePermissions: new Map([
			[
				resourceGrantKey('package', packageId),
				new Set<OrgPermission>(['package:read', 'package:execute']),
			],
		]),
		credentialScopes: null,
	}
}

test('followAdd stores the chosen events and changing them costs no create slot', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-events', name: '@ada/notes', isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(
		useGrantAccess('pkg-events'),
	)
	const env = { APP_DB: db } as Env
	const created = await addFollow({
		env,
		followerOrgId: 'org-events',
		creatorUserId: 'person-1',
		name: '@ada/notes',
		events: ['published'],
	})
	expect(created.events).toEqual(['published'])
	for (let index = 1; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-events')
	}
	const updated = await addFollow({
		env,
		followerOrgId: 'org-events',
		creatorUserId: 'person-1',
		name: '@ada/notes',
		events: ['pushed', 'published', 'pushed'],
	})
	expect(updated.events).toEqual(['published', 'pushed'])
	const kept = await addFollow({
		env,
		followerOrgId: 'org-events',
		creatorUserId: 'person-1',
		name: '@ada/notes',
	})
	expect(kept.events).toEqual(['published', 'pushed'])
})

test('followAdd rejects event choices the caller cannot receive', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	const env = { APP_DB: db } as Env
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockResolvedValue(
		savedPackage({ id: 'pkg-public', name: '@ada/notes', isPrivate: false }),
	)
	serviceMocks.loadFollowTargetPermissions.mockResolvedValue(null)
	const follow = (events: Array<'published' | 'pushed'>) =>
		addFollow({
			env,
			followerOrgId: 'org-outsider',
			creatorUserId: 'person-1',
			name: '@ada/notes',
			events,
		})
	await expect(follow([])).rejects.toThrow(/at least one event/)
	await expect(follow(['pushed'])).rejects.toThrow(/need read access/)
	await expect(follow(['published'])).resolves.toMatchObject({
		events: ['published'],
	})

	serviceMocks.getSavedPackageByName.mockResolvedValue(null)
	serviceMocks.getUserRepoByName.mockResolvedValue({
		id: 'repo-stash',
		userId: ownerId,
		name: 'stash',
		isPrivate: false,
	})
	await expect(
		addFollow({
			env,
			followerOrgId: 'org-outsider',
			creatorUserId: 'person-1',
			name: '@ada/stash',
			kind: 'repo',
			events: ['published'],
		}),
	).rejects.toThrow(/only be followed for pushes/)
})

test('removeFollow deletes by live target or by stored name', async () => {
	const db = followDb()
	await ensureFollowTables(db)
	const env = { APP_DB: db } as Env
	for (const [id, targetId, targetName] of [
		['follow-live', 'pkg-live', '@ada/live'],
		['follow-gone', 'pkg-gone', '@ada/gone'],
	] as const) {
		await insertFollow(db, {
			id,
			followerOrgId: 'org-remove',
			creatorUserId: 'person-1',
			targetKind: 'package',
			targetOwnerId: ownerId,
			targetId,
			targetName,
			createdAt: '2026-10-15T00:00:00.000Z',
		})
	}
	serviceMocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	serviceMocks.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			input.name === '@ada/renamed'
				? savedPackage({
						id: 'pkg-live',
						name: '@ada/renamed',
						isPrivate: false,
					})
				: null,
	)
	serviceMocks.getUserRepoByName.mockResolvedValue(null)
	await expect(
		removeFollow({ env, followerOrgId: 'org-remove', name: '@ada/renamed' }),
	).resolves.toMatchObject({ removed: { name: '@ada/live' } })
	await expect(
		removeFollow({ env, followerOrgId: 'org-remove', name: '@ADA/gone' }),
	).resolves.toMatchObject({ removed: { name: '@ada/gone' } })
	await expect(
		removeFollow({ env, followerOrgId: 'org-remove', name: '@ada/gone' }),
	).rejects.toBeInstanceOf(FollowNotFoundError)
	await expect(
		removeFollow({ env, followerOrgId: 'org-other', name: '@ada/renamed' }),
	).rejects.toBeInstanceOf(FollowNotFoundError)
})

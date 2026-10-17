import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	followOrgTarget,
	resumeOrgFollow,
	unfollowOrgTarget,
	loadOrgFollowsData,
	loadPackageFollowState,
	followOperationStatus,
} from '#app/follows-web.ts'
import { resourceGrantKey } from '#worker/authorization/access-compile.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import {
	ensureFollowTables,
	getFollowByTarget,
	insertFollow,
	pauseFollow,
} from '#worker/follow/repo.ts'
import { consumeFollowCreateSlot } from '#worker/follow/service.ts'
import { followCreateMaxPerHour } from '#worker/follow/types.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	getOrgBySlug: vi.fn(),
	getSavedPackageByName: vi.fn(),
	getSavedPackageByIdInAnyOrg: vi.fn(),
	getUserRepoByName: vi.fn(),
	loadFollowTargetPermissions: vi.fn(),
	listOrgsForPerson: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getOrgBySlug: mocks.getOrgBySlug,
		listOrgsForPerson: mocks.listOrgsForPerson,
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getSavedPackageByName: mocks.getSavedPackageByName,
		getSavedPackageByIdInAnyOrg: mocks.getSavedPackageByIdInAnyOrg,
	}
})

vi.mock('#worker/repo/user-repos.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getUserRepoByName: mocks.getUserRepoByName }
})

vi.mock('#worker/follow/access.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		loadFollowTargetPermissions: mocks.loadFollowTargetPermissions,
	}
})

const ownerId = ownerIdFromStored('org-ada')
const personId = 'person-jane'

function access(
	packagePermissions: Array<OrgPermission>,
): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set<OrgPermission>(),
		isOwner: false,
		resourcePermissions: new Map([
			[
				resourceGrantKey('package', 'pkg-notes'),
				new Set<OrgPermission>(packagePermissions),
			],
		]),
		credentialScopes: null,
		profileGrants: null,
	}
}

const user = {
	mcpUser: { userId: personId, personalOrgId: personId },
} as unknown as AuthenticatedAppUser

async function setup(input: { isPrivate?: boolean } = {}) {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureFollowTables(db)
	mocks.getOrgBySlug.mockResolvedValue({ id: ownerId, slug: 'ada' })
	mocks.getSavedPackageByName.mockResolvedValue({
		userId: ownerId,
		id: 'pkg-notes',
		name: '@ada/notes',
		isPrivate: input.isPrivate ?? false,
	})
	mocks.getUserRepoByName.mockResolvedValue(null)
	return { db, env: { APP_DB: db } as Env }
}

beforeEach(() => {
	vi.clearAllMocks()
})

test('followOperationStatus maps every error code to an HTTP status', () => {
	const error = (
		code: 'invalid' | 'not_found' | 'rate_limited' | 'unauthorized',
	) => followOperationStatus({ ok: false, code, error: '' })
	expect(error('invalid')).toBe(400)
	expect(error('unauthorized')).toBe(401)
	expect(error('not_found')).toBe(404)
	expect(error('rate_limited')).toBe(429)
	expect(
		followOperationStatus({
			ok: true,
			name: '@ada/notes',
			kind: 'package',
			follow: null,
		}),
	).toBe(200)
})

test('loadPackageFollowState lists member workspaces with personal first and gates pushes', async () => {
	const { db, env } = await setup()
	mocks.loadFollowTargetPermissions.mockResolvedValue(
		access(['package:execute']),
	)
	mocks.listOrgsForPerson.mockResolvedValue([
		{ id: 'org-team', slug: 'acme', display_name: 'Acme', role: 'member' },
		{ id: 'org-guest', slug: 'guest', display_name: 'Guest', role: null },
		{ id: personId, slug: 'jane', display_name: null, role: 'owner' },
	])
	await insertFollow(db, {
		id: 'follow-team',
		followerOrgId: 'org-team',
		creatorUserId: personId,
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-10-01T00:00:00.000Z',
		publishedEnabled: true,
		pushedEnabled: false,
	})

	const state = await loadPackageFollowState({
		env,
		user,
		username: 'ada',
		kodyId: 'notes',
		kind: undefined,
	})

	expect(state).toEqual({
		ok: true,
		target: { name: '@ada/notes', kind: 'package' },
		availableEvents: ['published', 'pushed'],
		canPush: false,
		workspaces: [
			{ slug: 'jane', displayName: null, personal: true, follow: null },
			{
				slug: 'acme',
				displayName: 'Acme',
				personal: false,
				follow: {
					status: 'active',
					events: ['published'],
					pausedAt: null,
					pausedReason: null,
					lastDeliverySkipReason: null,
				},
			},
		],
	})
})

test('loadPackageFollowState hides private targets the viewer can only run', async () => {
	const { env } = await setup({ isPrivate: true })
	mocks.loadFollowTargetPermissions.mockResolvedValue(
		access(['package:execute']),
	)
	mocks.listOrgsForPerson.mockResolvedValue([])
	expect(
		await loadPackageFollowState({
			env,
			user,
			username: 'ada',
			kodyId: 'notes',
			kind: 'package',
		}),
	).toBeNull()
})

test('named follow operations follows with chosen events, explains push gating, and unfollows', async () => {
	const { db, env } = await setup()
	mocks.loadFollowTargetPermissions.mockResolvedValue(
		access(['package:execute']),
	)
	const org = { id: 'org-team' }

	const gated = await followOrgTarget({
		env,
		user,
		org,
		name: '@ada/notes',
		kind: 'package',
		events: ['pushed'],
	})
	expect(gated).toMatchObject({ ok: false, code: 'invalid' })
	expect(gated.ok ? '' : gated.error).toMatch(/run-only access does not/)

	const followed = await followOrgTarget({
		env,
		user,
		org,
		name: '@ada/notes',
		kind: 'package',
		events: ['published'],
	})
	expect(followed).toMatchObject({
		ok: true,
		name: '@ada/notes',
		follow: { status: 'active', events: ['published'] },
	})

	const record = await getFollowByTarget(db, {
		followerOrgId: 'org-team',
		targetKind: 'package',
		targetId: 'pkg-notes',
	})
	expect(record).not.toBeNull()
	const otherOrg = await unfollowOrgTarget({
		env,
		user,
		org: { id: 'org-other' },
		id: record!.id,
	})
	expect(otherOrg).toMatchObject({ ok: false, code: 'not_found' })

	expect(
		await unfollowOrgTarget({
			env,
			user,
			org,
			id: record!.id,
		}),
	).toMatchObject({ ok: true, follow: null })
	expect(
		await getFollowByTarget(db, {
			followerOrgId: 'org-team',
			targetKind: 'package',
			targetId: 'pkg-notes',
		}),
	).toBeNull()
})

test('named follow operations resumes a listed follow by id after its target is renamed', async () => {
	const { db, env } = await setup()
	const renamed = {
		userId: ownerId,
		id: 'pkg-notes',
		name: '@ada/journal',
		isPrivate: false,
	}
	mocks.getSavedPackageByName.mockResolvedValue(renamed)
	mocks.getSavedPackageByIdInAnyOrg.mockResolvedValue(renamed)
	mocks.loadFollowTargetPermissions.mockResolvedValue(access(['package:read']))
	await insertFollow(db, {
		id: 'follow-renamed',
		followerOrgId: 'org-team',
		creatorUserId: personId,
		targetKind: 'package',
		targetOwnerId: ownerId,
		targetId: 'pkg-notes',
		targetName: '@ada/notes',
		createdAt: '2026-09-01T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-renamed',
		pausedAt: '2026-10-01T00:00:00.000Z',
		reason: 'access_lost',
	})

	expect(
		await resumeOrgFollow({
			env,
			user,
			org: { id: 'org-other' },
			id: 'follow-renamed',
		}),
	).toMatchObject({ ok: false, code: 'not_found' })

	const resumed = await resumeOrgFollow({
		env,
		user,
		org: { id: 'org-team' },
		id: 'follow-renamed',
	})
	expect(resumed).toMatchObject({
		ok: true,
		follow: { status: 'active' },
	})

	mocks.getSavedPackageByIdInAnyOrg.mockResolvedValue(null)
	await pauseFollow(db, {
		id: 'follow-renamed',
		pausedAt: '2026-10-02T00:00:00.000Z',
		reason: 'target_missing',
	})
	const gone = await resumeOrgFollow({
		env,
		user,
		org: { id: 'org-team' },
		id: 'follow-renamed',
	})
	expect(gone).toMatchObject({ ok: false, code: 'not_found' })
	expect(gone.ok ? '' : gone.error).toMatch(/no longer exists/)
})

test('named follow operations reports the hourly new-follow limit', async () => {
	const { env, db } = await setup()
	mocks.loadFollowTargetPermissions.mockResolvedValue(access(['package:read']))
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-busy')
	}
	const payload = await followOrgTarget({
		env,
		user,
		org: { id: 'org-busy' },
		name: '@ada/notes',
		kind: 'package',
	})
	expect(payload).toMatchObject({ ok: false, code: 'rate_limited' })
	expect(followOperationStatus(payload)).toBe(429)
})

test('loadOrgFollowsData shows pause reasons and when paused follows are deleted', async () => {
	const { db, env } = await setup()
	await insertFollow(db, {
		id: 'follow-paused',
		followerOrgId: 'org-team',
		creatorUserId: personId,
		targetKind: 'repo',
		targetOwnerId: ownerId,
		targetId: 'repo-gone',
		targetName: '@ada/scripts',
		createdAt: '2026-09-01T00:00:00.000Z',
	})
	await pauseFollow(db, {
		id: 'follow-paused',
		pausedAt: '2026-10-01T00:00:00.000Z',
		reason: 'target_missing',
	})

	const data = await loadOrgFollowsData({
		env,
		org: { id: 'org-team', slug: 'acme' },
	})

	expect(data.orgSlug).toBe('acme')
	expect(data.follows).toEqual([
		expect.objectContaining({
			id: 'follow-paused',
			name: '@ada/scripts',
			kind: 'repo',
			href: '/@ada/scripts',
			status: 'paused',
			pausedReason: 'target_missing',
			events: ['pushed'],
			availableEvents: ['pushed'],
			deleteAt: '2026-10-31T00:00:00.000Z',
		}),
	])
})

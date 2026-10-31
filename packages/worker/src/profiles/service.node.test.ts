import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createProfile,
	listProfiles,
	type ProfilesCaller,
	revokeProfile,
	updateProfile,
} from './service.ts'
import { purgeProfiles, revokeProfilesForMember } from './store.ts'

const pkg = 'pkg_tools'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const callerFor = (input: {
		userId?: string
		profileId?: string | null
		isOwner?: boolean
		holds?: ProfilesCaller['holds']
	}) =>
		({
			env: { APP_DB: db },
			orgId: 'org_acme',
			actor: {
				userId: input.userId ?? 'user_kent',
				profileId: input.profileId ?? null,
				isOwner: input.isOwner ?? false,
			},
			holds: input.holds ?? (() => true),
		}) as unknown as ProfilesCaller
	const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n
	return { sqlite, db, callerFor, count }
}

const readExecute = [
	{
		resourceType: 'package' as const,
		resourceId: pkg,
		permissions: ['package:read' as const, 'package:execute' as const],
	},
]

test('a person creates a profile with a snapshot of their own access', async () => {
	const { callerFor, count } = setup()
	const profile = await createProfile(callerFor({}), {
		name: 'release-bot',
		grants: readExecute,
	})
	expect(profile).toMatchObject({
		name: 'release-bot',
		depth: 1,
		status: 'active',
		chain: [{ name: 'release-bot' }],
		grants: [
			{
				resourceType: 'package',
				resourceId: pkg,
				permissions: expect.arrayContaining([
					'package:read',
					'package:execute',
				]),
			},
		],
	})
	expect(
		count(
			`SELECT COUNT(*) AS n FROM grants WHERE subject_type = 'profile' AND subject_id = '${profile.id}'`,
		),
	).toBe(1)
	// Profile grants never bump the org's access epoch.
	expect(count(`SELECT COUNT(*) AS n FROM orgs WHERE access_epoch > 0`)).toBe(0)
})

test('a profile cannot get access its creator lacks', async () => {
	const { callerFor } = setup()
	await expect(
		createProfile(callerFor({ holds: (_t, _id, p) => p === 'package:read' }), {
			name: 'bot',
			grants: readExecute,
		}),
	).rejects.toMatchObject({ code: 'profile_grant_exceeds_caller' })
})

test('a sub-profile is capped by its parent: grants, expiry, and depth', async () => {
	const { callerFor } = setup()
	const me = callerFor({})
	const parent = await createProfile(me, {
		name: 'agent',
		expiresAt: '2099-01-01T00:00:00Z',
		grants: [
			{
				resourceType: 'package',
				resourceId: pkg,
				permissions: ['package:read'],
			},
		],
	})
	await expect(
		createProfile(me, {
			name: 'helper',
			parentProfileId: parent.id,
			grants: readExecute,
		}),
	).rejects.toMatchObject({ code: 'profile_grant_exceeds_parent' })
	await expect(
		createProfile(me, {
			name: 'helper',
			parentProfileId: parent.id,
			expiresAt: '2100-01-01T00:00:00Z',
		}),
	).rejects.toMatchObject({ code: 'profile_expiry_extension' })
	const child = await createProfile(me, {
		name: 'helper',
		parentProfileId: parent.id,
		grants: [
			{
				resourceType: 'package',
				resourceId: pkg,
				permissions: ['package:read'],
			},
		],
	})
	expect(child).toMatchObject({
		depth: 2,
		expiresAt: '2099-01-01T00:00:00.000Z',
		chain: [{ name: 'agent' }, { name: 'helper' }],
	})
	let tip = child
	for (const name of ['l3', 'l4', 'l5']) {
		tip = await createProfile(me, { name, parentProfileId: tip.id })
	}
	expect(tip.depth).toBe(5)
	await expect(
		createProfile(me, { name: 'l6', parentProfileId: tip.id }),
	).rejects.toMatchObject({ code: 'profile_depth_exceeded' })
})

test('names are unique per parent, and org-wide grants are refused', async () => {
	const { callerFor } = setup()
	const me = callerFor({})
	await createProfile(me, { name: 'bot' })
	await expect(createProfile(me, { name: 'bot' })).rejects.toMatchObject({
		code: 'profile_name_taken',
	})
	await expect(
		createProfile(me, {
			name: 'wide',
			grants: [
				{
					resourceType: 'org' as never,
					resourceId: 'org_acme',
					permissions: ['package:read'],
				},
			],
		}),
	).rejects.toMatchObject({ code: 'profile_grant_not_allowed' })
})

test('a profile cannot edit itself, an ancestor, or a sibling; it can edit a descendant', async () => {
	const { callerFor } = setup()
	const me = callerFor({})
	const root = await createProfile(me, { name: 'root' })
	const a = await createProfile(me, { name: 'a', parentProfileId: root.id })
	const b = await createProfile(me, { name: 'b', parentProfileId: root.id })
	const aChild = await createProfile(me, { name: 'a1', parentProfileId: a.id })
	const asA = callerFor({ profileId: a.id })
	const soon = '2098-01-01T00:00:00Z'
	for (const target of [a, root, b]) {
		await expect(
			updateProfile(asA, { profileId: target.id, expiresAt: soon }),
		).rejects.toMatchObject({ code: expect.stringMatching(/not_/) })
	}
	await expect(
		updateProfile(asA, { profileId: aChild.id, expiresAt: soon }),
	).resolves.toMatchObject({ expiresAt: '2098-01-01T00:00:00.000Z' })
	// A profile creating a profile makes a sub-profile of itself.
	const made = await createProfile(asA, { name: 'a2' })
	expect(made.chain.map((entry) => entry.name)).toEqual(['root', 'a', 'a2'])
	expect(made.createdByProfileId).toBe(a.id)
	expect((await listProfiles(asA)).map((p) => p.name).sort()).toEqual([
		'a1',
		'a2',
	])
})

test('expiry only shortens', async () => {
	const { callerFor } = setup()
	const me = callerFor({})
	const bot = await createProfile(me, {
		name: 'bot',
		expiresAt: '2099-01-01T00:00:00Z',
	})
	await expect(
		updateProfile(me, { profileId: bot.id, expiresAt: '2100-01-01T00:00:00Z' }),
	).rejects.toMatchObject({ code: 'profile_expiry_extension' })
	await expect(
		updateProfile(me, { profileId: bot.id, expiresAt: '2098-01-01T00:00:00Z' }),
	).resolves.toMatchObject({ expiresAt: '2098-01-01T00:00:00.000Z' })
})

test('an Owner lists and revokes another member’s profile but cannot edit it; revoke cascades and is final', async () => {
	const { callerFor } = setup()
	const me = callerFor({})
	const root = await createProfile(me, { name: 'root' })
	const child = await createProfile(me, {
		name: 'child',
		parentProfileId: root.id,
	})
	const owner = callerFor({ userId: 'user_owner', isOwner: true })
	const stranger = callerFor({ userId: 'user_other' })
	expect(await listProfiles(stranger)).toEqual([])
	await expect(
		listProfiles(stranger, { allMembers: true }),
	).rejects.toMatchObject({ code: 'not_allowed' })
	expect(await listProfiles(owner, { allMembers: true })).toHaveLength(2)
	await expect(
		updateProfile(owner, {
			profileId: root.id,
			expiresAt: '2098-01-01T00:00:00Z',
		}),
	).rejects.toMatchObject({ code: 'not_allowed' })
	await expect(
		revokeProfile(stranger, { profileId: root.id }),
	).rejects.toMatchObject({ status: 403 })
	expect(await revokeProfile(owner, { profileId: root.id })).toMatchObject({
		status: 'revoked',
	})
	const [listedChild] = (await listProfiles(me)).filter(
		(p) => p.id === child.id,
	)
	expect(listedChild?.status).toBe('parent_inactive')
	await expect(
		createProfile(me, { name: 'late', parentProfileId: child.id }),
	).rejects.toMatchObject({ code: 'profile_inactive' })
	await expect(
		updateProfile(me, {
			profileId: root.id,
			expiresAt: '2098-01-01T00:00:00Z',
		}),
	).rejects.toMatchObject({ code: 'profile_inactive' })
})

test('offboarding revokes a member’s profiles and purge removes them with their grants after 30 days', async () => {
	const { callerFor, db, count, sqlite } = setup()
	const me = callerFor({})
	const root = await createProfile(me, { name: 'root', grants: readExecute })
	await createProfile(me, {
		name: 'child',
		parentProfileId: root.id,
		grants: readExecute,
	})
	await createProfile(callerFor({ userId: 'user_cole' }), { name: 'keep' })
	await revokeProfilesForMember(db, {
		orgId: 'org_acme',
		userId: 'user_kent',
		now: '2026-01-01T00:00:00.000Z',
	})
	expect(
		count(`SELECT COUNT(*) AS n FROM profiles WHERE revoked_at IS NOT NULL`),
	).toBe(2)
	await purgeProfiles(db, { now: new Date('2026-01-15T00:00:00.000Z') })
	expect(count(`SELECT COUNT(*) AS n FROM profiles`)).toBe(3)
	sqlite.exec('PRAGMA foreign_keys = ON')
	const purged = await purgeProfiles(db, {
		now: new Date('2026-02-15T00:00:00.000Z'),
	})
	expect(purged).toMatchObject({ profiles: 2, grants: 2 })
	expect(count(`SELECT COUNT(*) AS n FROM profiles`)).toBe(1)
	expect(
		count(`SELECT COUNT(*) AS n FROM grants WHERE subject_type = 'profile'`),
	).toBe(0)
})

test('purge removes a revoked profile with descendants that never expire', async () => {
	const { callerFor, db, count } = setup()
	const me = callerFor({})
	const root = await createProfile(me, { name: 'root', grants: readExecute })
	await createProfile(me, {
		name: 'child',
		parentProfileId: root.id,
		grants: readExecute,
	})
	await revokeProfile(me, { profileId: root.id })
	const purged = await purgeProfiles(db, {
		now: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
	})
	expect(purged.profiles).toBe(2)
	expect(count(`SELECT COUNT(*) AS n FROM profiles`)).toBe(0)
})

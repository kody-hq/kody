import { DatabaseSync } from 'node:sqlite'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	grantPackageToProfile,
	listGrantableProfiles,
	listPackageProfileGrants,
	removePackageProfileGrant,
} from './package-grants.ts'
import { createProfile, type ProfilesCaller, revokeProfile } from './service.ts'

const flag = vi.hoisted(() => ({ on: true }))
vi.mock('./flag.ts', () => ({ isProfilesEnabledFor: async () => flag.on }))

const pkg = 'pkg_tools'
const orgId = 'org_acme'

function setup() {
	flag.on = true
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const caller = (profileId: string | null = null) =>
		({
			env: { APP_DB: db },
			orgId,
			actor: { userId: 'user_kent', profileId, isOwner: false },
			holds: () => true,
		}) as unknown as ProfilesCaller
	const request = {
		org: { id: orgId },
		actor: { userId: 'user_kent' },
		credential: { kind: 'session', id: 's1', scopes: null, profileName: null },
	} as unknown as RequestContext
	const grant = (profileId: string, preset: 'use' | 'contribute' | 'manage') =>
		grantPackageToProfile({
			env: { APP_DB: db },
			request,
			packageId: pkg,
			profileId,
			preset,
		})
	return { db, caller, grant }
}

test('a package grants a profile access like a collaborator, capped by its parents', async () => {
	const { db, caller, grant } = setup()
	const parent = await createProfile(caller(), { name: 'agent', grants: [] })
	const child = await createProfile(caller(parent.id), {
		name: 'helper',
		grants: [],
	})
	await expect(grant(child.id, 'use')).rejects.toThrow(
		'Parent profile "agent" does not hold',
	)
	await grant(parent.id, 'manage')
	await grant(child.id, 'use')
	const listed = await listPackageProfileGrants({ db, orgId, packageId: pkg })
	expect(listed.map((entry) => entry.profileName).sort()).toEqual([
		'agent',
		'helper',
	])
	expect(listed.every((entry) => entry.active)).toBe(true)
	// Re-granting replaces the profile's grant instead of stacking a second one.
	await grant(parent.id, 'contribute')
	expect(
		(await listPackageProfileGrants({ db, orgId, packageId: pkg })).length,
	).toBe(2)
	const helperGrant = listed.find((entry) => entry.profileName === 'helper')!
	expect(
		await removePackageProfileGrant({
			db,
			orgId,
			packageId: pkg,
			grantId: helperGrant.grantId,
		}),
	).toBe(true)
	expect(
		(await listPackageProfileGrants({ db, orgId, packageId: pkg })).map(
			(entry) => entry.profileName,
		),
	).toEqual(['agent'])
})

test('revoked profiles and the experiment being off are refused', async () => {
	const { caller, grant, db } = setup()
	const profile = await createProfile(caller(), { name: 'agent', grants: [] })
	expect(
		(await listGrantableProfiles({ db, orgId, actingUserId: 'user_kent' })).map(
			(entry) => entry.name,
		),
	).toEqual(['agent'])
	flag.on = false
	await expect(grant(profile.id, 'use')).rejects.toThrow()
	flag.on = true
	await revokeProfile(caller(), { profileId: profile.id })
	await expect(grant(profile.id, 'use')).rejects.toThrow('no longer active')
	expect(
		await listGrantableProfiles({ db, orgId, actingUserId: 'user_kent' }),
	).toEqual([])
	await expect(grant('prf_missing', 'use')).rejects.toThrow('No profile')
})

test("another member's profile cannot be given access", async () => {
	const { caller, db } = setup()
	const mine = await createProfile(caller(), { name: 'agent', grants: [] })
	const otherRequest = {
		org: { id: orgId },
		actor: { userId: 'user_jane' },
		credential: { kind: 'session', id: 's2', scopes: null, profileName: null },
	} as unknown as RequestContext
	await expect(
		grantPackageToProfile({
			env: { APP_DB: db },
			request: otherRequest,
			packageId: pkg,
			profileId: mine.id,
			preset: 'use',
		}),
	).rejects.toThrow('You can only give access to your own profiles')
})

test('a sub-profile under a revoked parent is listed inactive and not grantable', async () => {
	const { db, caller, grant } = setup()
	const parent = await createProfile(caller(), { name: 'agent', grants: [] })
	const child = await createProfile(caller(parent.id), {
		name: 'helper',
		grants: [],
	})
	await grant(parent.id, 'use')
	await grant(child.id, 'use')
	await revokeProfile(caller(), { profileId: parent.id })
	const listed = await listPackageProfileGrants({ db, orgId, packageId: pkg })
	expect(listed.every((entry) => !entry.active)).toBe(true)
	expect(
		await listGrantableProfiles({ db, orgId, actingUserId: 'user_kent' }),
	).toEqual([])
})

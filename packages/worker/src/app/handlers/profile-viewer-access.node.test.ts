/**
 * Profile package list is filtered by the viewer's real org access: personal
 * org id (not person id), canSeeResource for owners/members/grants, and
 * public-only SQL for anonymous and unrelated signed-in viewers.
 */
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

const { loadProfileData } = await import('../profile-data.ts')

const ownerPersonId = 'a'.repeat(64)
const ownerOrgId = 'b'.repeat(64)
const otherPersonId = 'c'.repeat(64)
const otherOrgId = 'd'.repeat(64)
const grantPersonId = 'e'.repeat(64)
const grantOrgId = 'f'.repeat(64)
const now = '2026-01-01T00:00:00.000Z'

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))

	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	insertOrg.run(ownerOrgId, 'owner', 'Owner', now, now)
	insertOrg.run(otherOrgId, 'other', 'Other', now, now)
	insertOrg.run(grantOrgId, 'grantee', 'Grantee', now, now)

	const insertUser = sqlite.prepare(
		`INSERT INTO users (
			username, email, stable_user_id, personal_org_id, password_hash,
			profile_visibility, created_at
		) VALUES (?, ?, ?, ?, 'hash', 'public', ?)`,
	)
	insertUser.run('owner', 'owner@example.com', ownerPersonId, ownerOrgId, now)
	insertUser.run('other', 'other@example.com', otherPersonId, otherOrgId, now)
	insertUser.run(
		'grantee',
		'grantee@example.com',
		grantPersonId,
		grantOrgId,
		now,
	)

	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertMembership.run(ownerOrgId, ownerPersonId, 'owner', now)
	insertMembership.run(otherOrgId, otherPersonId, 'owner', now)
	insertMembership.run(grantOrgId, grantPersonId, 'owner', now)

	sqlite
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run('owner', null, ownerOrgId, now)

	const insertPackage = sqlite.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id,
			is_private, hidden, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
	)
	insertPackage.run(
		'pkg-public',
		ownerOrgId,
		'@owner/public-notes',
		'public-notes',
		'public',
		'src-public',
		0,
		now,
		now,
	)
	insertPackage.run(
		'pkg-private',
		ownerOrgId,
		'@owner/private-notes',
		'private-notes',
		'private',
		'src-private',
		1,
		now,
		now,
	)
	insertPackage.run(
		'pkg-shared',
		ownerOrgId,
		'@owner/shared-notes',
		'shared-notes',
		'shared',
		'src-shared',
		1,
		now,
		now,
	)
	// Wrong key: packages stored under the person id must not appear.
	insertPackage.run(
		'pkg-person-key',
		ownerPersonId,
		'@owner/person-keyed',
		'person-keyed',
		'leak',
		'src-person',
		0,
		now,
		now,
	)

	const insertGrant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, 'package', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
	)
	insertGrant.run(
		'grant-shared',
		ownerOrgId,
		'pkg-shared',
		grantPersonId,
		ownerPersonId,
		now,
		now,
	)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
		)
		.run('grant-shared', 'package:read')
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
		)
		.run('grant-shared', 'package:execute')

	return { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
}

async function loadAs(
	env: Env,
	viewer: { personId: string; username: string } | null,
) {
	mocks.readAuthenticatedAppUser.mockResolvedValue(
		viewer
			? {
					username: viewer.username,
					mcpUser: {
						userId: personIdFromStored(viewer.personId),
						username: viewer.username,
						personalOrgId: ownerIdFromStored(
							viewer.personId === ownerPersonId
								? ownerOrgId
								: viewer.personId === grantPersonId
									? grantOrgId
									: otherOrgId,
						),
					},
				}
			: null,
	)
	return loadProfileData(
		env,
		new Request('https://example.com/@owner'),
		'owner',
		undefined,
		{
			query: '',
		},
	)
}

function packageIds(
	data: Awaited<ReturnType<typeof loadProfileData>>,
): Array<string> {
	return (data?.packages ?? []).map((pkg) => pkg.kodyId).sort()
}

function packagePayload(
	data: Awaited<ReturnType<typeof loadProfileData>>,
): Array<{ kodyId: string; isPrivate?: boolean }> {
	return (data?.packages ?? []).map((pkg) => ({
		kodyId: pkg.kodyId,
		...(pkg.isPrivate === undefined ? {} : { isPrivate: pkg.isPrivate }),
	}))
}

test('self view lists private packages under the personal org id with Private badges', async () => {
	const env = createEnv()
	const data = await loadAs(env, {
		personId: ownerPersonId,
		username: 'owner',
	})
	expect(data?.isSelf).toBe(true)
	expect(packageIds(data)).toEqual([
		'private-notes',
		'public-notes',
		'shared-notes',
	])
	expect(packagePayload(data)).toEqual(
		expect.arrayContaining([
			{ kodyId: 'private-notes', isPrivate: true },
			{ kodyId: 'public-notes', isPrivate: false },
			{ kodyId: 'shared-notes', isPrivate: true },
		]),
	)
	expect(packageIds(data)).not.toContain('person-keyed')
})

test('granted user sees public packages plus granted private ones only', async () => {
	const env = createEnv()
	const data = await loadAs(env, {
		personId: grantPersonId,
		username: 'grantee',
	})
	expect(data?.isSelf).toBe(false)
	expect(packageIds(data)).toEqual(['public-notes', 'shared-notes'])
	expect(packagePayload(data)).toEqual(
		expect.arrayContaining([
			{ kodyId: 'public-notes', isPrivate: false },
			{ kodyId: 'shared-notes', isPrivate: true },
		]),
	)
	expect(JSON.stringify(data)).not.toContain('private-notes')
	expect(JSON.stringify(data)).not.toContain('person-keyed')
})

test('other signed-in user sees only public packages and no private names', async () => {
	const env = createEnv()
	const data = await loadAs(env, {
		personId: otherPersonId,
		username: 'other',
	})
	expect(data?.isSelf).toBe(false)
	expect(packageIds(data)).toEqual(['public-notes'])
	expect(packagePayload(data)).toEqual([{ kodyId: 'public-notes' }])
	expect(JSON.stringify(data)).not.toContain('private-notes')
	expect(JSON.stringify(data)).not.toContain('shared-notes')
	expect(JSON.stringify(data)).not.toContain('isPrivate')
})

test('anonymous viewer sees only public packages and no private names', async () => {
	const env = createEnv()
	const data = await loadAs(env, null)
	expect(data?.loggedIn).toBe(false)
	expect(data?.isSelf).toBe(false)
	expect(packageIds(data)).toEqual(['public-notes'])
	expect(packagePayload(data)).toEqual([{ kodyId: 'public-notes' }])
	expect(JSON.stringify(data)).not.toContain('private-notes')
	expect(JSON.stringify(data)).not.toContain('shared-notes')
	expect(JSON.stringify(data)).not.toContain('person-keyed')
	expect(JSON.stringify(data)).not.toContain('isPrivate')
})

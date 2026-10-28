import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { retirePackageSlug } from '#worker/community/package-url.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	packageDetailInputs: [] as Array<Record<string, unknown>>,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/account-packages-data.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/account-packages-data.ts')>()
	return {
		...actual,
		loadAccountPackageDetail: (
			input: Parameters<typeof actual.loadAccountPackageDetail>[0],
		) => {
			mocks.packageDetailInputs.push(input)
			return actual.loadAccountPackageDetail(input)
		},
	}
})

const { loadPackagePage } = await import('./package-page.ts')

const ownerId = 'person-owner'
const memberId = 'person-member'
const outsiderId = 'person-outsider'
const teamId = 'org-acme'
const now = '2026-01-01T00:00:00.000Z'

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	sqlite
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		)
		.run('acme', teamId, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
		[outsiderId, 'outsider'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
		insertMembership.run(id, id, 'owner', now)
	}
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	const insertPackage = sqlite.prepare(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, is_private)
		 VALUES (?, ?, ?, ?, 'pkg', ?, 1)`,
	)
	insertPackage.run('pkg-shared', teamId, '@acme/shared', 'shared', 'src-1')
	insertPackage.run('pkg-secret', teamId, '@acme/secret', 'secret', 'src-2')
	const insertGrant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, 'package', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
	)
	const insertGrantPermission = sqlite.prepare(
		`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
	)
	insertGrant.run(
		'grant-read',
		teamId,
		'pkg-shared',
		memberId,
		ownerId,
		now,
		now,
	)
	insertGrantPermission.run('grant-read', 'package:read')
	insertGrant.run(
		'grant-run',
		teamId,
		'pkg-secret',
		memberId,
		ownerId,
		now,
		now,
	)
	insertGrantPermission.run('grant-run', 'package:execute')
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'https://kody.test',
	} as unknown as Env
	await retirePackageSlug({
		db: env.APP_DB,
		userId: teamId,
		packageId: 'pkg-shared',
		oldSlug: 'old-shared',
		newSlug: 'shared',
	})
	return env
}

function loadAs(env: Env, personId: string | null, kodyId: string) {
	mocks.readAuthenticatedAppUser.mockResolvedValue(
		personId
			? {
					username: personId,
					mcpUser: { userId: personId, username: personId },
				}
			: null,
	)
	return loadPackagePage({
		env,
		request: new Request(`https://kody.test/@acme/${kodyId}`),
		username: 'acme',
		kodyId,
	})
}

test('team package pages open for viewers who can read the package in the team org', async () => {
	const env = await createEnv()

	await expect(loadAs(env, ownerId, 'secret')).resolves.toMatchObject({
		kind: 'page',
		username: 'acme',
		kodyId: 'secret',
		viewerIsOwner: true,
		viewerCanManage: true,
		ownerUserId: teamId,
		ownerPackage: { id: 'pkg-secret', name: '@acme/secret' },
	})
	await expect(loadAs(env, memberId, 'shared')).resolves.toMatchObject({
		kind: 'page',
		viewerIsOwner: true,
		viewerCanManage: false,
		ownerPackage: { id: 'pkg-shared' },
	})
	expect(mocks.packageDetailInputs).not.toHaveLength(0)
	const manageable = mocks.packageDetailInputs.filter((input) =>
		Object.hasOwn(input, 'creditAttributionUsername'),
	)
	const readOnly = mocks.packageDetailInputs.filter(
		(input) => !Object.hasOwn(input, 'creditAttributionUsername'),
	)
	expect(manageable.length).toBeGreaterThan(0)
	expect(readOnly.length).toBeGreaterThan(0)
	for (const input of manageable) {
		expect(input).toMatchObject({ creditAttributionUsername: 'acme' })
	}
})

test('team package pages deny signed-in outsiders clearly and stay opaque to anonymous', async () => {
	const env = await createEnv()

	// Execute-only grant: package is real, but package:read is missing.
	await expect(loadAs(env, memberId, 'secret')).resolves.toEqual({
		kind: 'no_access',
		username: 'acme',
		kodyId: 'secret',
		packageName: '@acme/secret',
		viewerUsername: memberId,
	})
	await expect(loadAs(env, outsiderId, 'shared')).resolves.toEqual({
		kind: 'no_access',
		username: 'acme',
		kodyId: 'shared',
		packageName: '@acme/shared',
		viewerUsername: outsiderId,
	})
	// Anonymous visitors must not learn that a private package exists.
	await expect(loadAs(env, null, 'shared')).resolves.toEqual({
		kind: 'not_found',
	})
})

test('an unlisted team package rename only redirects viewers who can read it', async () => {
	const env = await createEnv()

	await expect(loadAs(env, memberId, 'old-shared')).resolves.toEqual({
		kind: 'redirect',
		to: '/@acme/shared',
		shared: false,
	})
	await expect(loadAs(env, outsiderId, 'old-shared')).resolves.toEqual({
		kind: 'not_found',
	})
})

test('a package page reads the org access epoch once per load', async () => {
	const env = await createEnv()
	const prepare = vi.spyOn(env.APP_DB, 'prepare')
	const epochReads = () =>
		prepare.mock.calls.filter(([sql]) =>
			/SELECT access_epoch FROM orgs WHERE id = \?/.test(String(sql)),
		).length

	await expect(loadAs(env, memberId, 'shared')).resolves.toMatchObject({
		kind: 'page',
		viewerIsOwner: true,
		viewerCanManage: false,
	})
	expect(epochReads()).toBe(1)

	// A later request still sees a revocation: nothing outlives the load.
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`UPDATE grants SET deleted_at = ? WHERE id = 'grant-read'`,
		).bind(now),
		env.APP_DB.prepare(
			`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`,
		).bind(teamId),
	])
	await expect(loadAs(env, memberId, 'shared')).resolves.toMatchObject({
		kind: 'no_access',
	})
})

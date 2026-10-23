import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	assignUserRole,
	getUserRolesAndPermissions,
} from '#worker/identity/permissions-db.ts'
import {
	requireUserWithPermission,
	requireUserWithRole,
} from '#app/permissions-server.ts'
import { type RoleName } from '#universal/permissions.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

async function setupRbac(users: Array<{ id: number; roles: Array<RoleName> }>) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	for (const { id, roles } of users) {
		const email = `user-${id}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, stable_user_id, password_hash)
				VALUES (?, ?, ?, ?, 'unused')`,
			)
			.run(id, `user-${id}`, email, stableUserId)
		await provisionPersonalOrg(db, {
			stableUserId,
			username: `user-${id}`,
		})
		for (const roleName of roles) {
			await assignUserRole({ db, userId: id, roleName })
		}
	}
	return { sqlite, db }
}

const ownPermissions = ['create', 'read', 'update', 'delete'].flatMap(
	(action) => ['role', 'user'].map((entity) => `${action}:${entity}:own`),
)
const anyPermissions = ownPermissions.map((p) => p.replace(':own', ':any'))

test('assignUserRole grants role permissions and getUserRolesAndPermissions unions them across roles', async () => {
	const { sqlite, db } = await setupRbac([
		{ id: 1, roles: ['user'] },
		{ id: 2, roles: ['user', 'admin'] },
		{ id: 3, roles: [] },
	])

	expect(await getUserRolesAndPermissions(db, 1)).toEqual({
		roles: ['user'],
		permissions: [...ownPermissions].sort(),
	})
	expect(await getUserRolesAndPermissions(db, 2)).toEqual({
		roles: ['admin', 'user'],
		permissions: [...anyPermissions, ...ownPermissions].sort(),
	})
	expect(await getUserRolesAndPermissions(db, 3)).toEqual({
		roles: [],
		permissions: [],
	})

	// Role membership still resolves when a role has no permission rows.
	sqlite.exec(`DELETE FROM role_permissions`)
	expect(await getUserRolesAndPermissions(db, 2)).toEqual({
		roles: ['admin', 'user'],
		permissions: [],
	})
})

test('requireUserWithPermission and requireUserWithRole enforce auth and authorization', async () => {
	setAuthSessionSecret(testCookieSecret)
	const makeEnv = async (roles: Array<RoleName>) =>
		({
			COOKIE_SECRET: testCookieSecret,
			APP_DB: (await setupRbac([{ id: 1, roles }])).db,
		}) as Env
	const adminEnv = await makeEnv(['admin'])
	const userOnlyEnv = await makeEnv(['user'])
	const email = 'user-1@example.com'
	const cookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(email),
			email,
			rememberMe: false,
		},
		false,
	)
	const request = (path: string, headers: Record<string, string> = {}) =>
		new Request(`https://example.com${path}`, { headers })
	const signedInJson = { Accept: 'application/json', Cookie: cookie }

	await expect(
		requireUserWithPermission(
			request('/admin/users.json', signedInJson),
			adminEnv,
			'read:user:any',
		),
	).resolves.toMatchObject({ userId: 1, roles: ['admin'] })
	await expect(
		requireUserWithPermission(
			request('/admin/users.json', signedInJson),
			userOnlyEnv,
			'read:user:any',
		),
	).rejects.toMatchObject({ status: 403 })

	const forbiddenHtml = await requireUserWithRole(
		request('/admin/users', { Cookie: cookie }),
		userOnlyEnv,
		'admin',
	).catch((response) => response)
	expect(forbiddenHtml).toBeInstanceOf(Response)
	expect(forbiddenHtml.status).toBe(403)

	await expect(
		requireUserWithRole(
			request('/admin/users.json', { Accept: 'application/json' }),
			adminEnv,
			'admin',
		),
	).rejects.toMatchObject({ status: 401 })

	const redirect = await requireUserWithRole(
		request('/admin/users'),
		adminEnv,
		'admin',
	).catch((response) => response)
	expect(redirect).toBeInstanceOf(Response)
	expect(redirect.status).toBe(302)
	expect(redirect.headers.get('Location')).toContain('/login')
})

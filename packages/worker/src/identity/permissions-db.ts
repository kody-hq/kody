import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type PermissionRow = {
	role_name: string
	action: string | null
	entity: string | null
	access: string | null
}

function formatPermissionString(row: {
	action: string
	entity: string
	access: string
}): PermissionString {
	return `${row.action}:${row.entity}:${row.access}` as PermissionString
}

export function parseUserRolesAndPermissionRows(
	rows: Array<PermissionRow> | null | undefined,
): { roles: Array<RoleName>; permissions: Array<PermissionString> } {
	const roleSet = new Set<RoleName>()
	const permissionSet = new Set<PermissionString>()
	for (const row of rows ?? []) {
		if (row.role_name === 'user' || row.role_name === 'admin') {
			roleSet.add(row.role_name)
		}
		const { action, entity, access } = row
		if (action && entity && access) {
			permissionSet.add(formatPermissionString({ action, entity, access }))
		}
	}

	return {
		roles: Array.from(roleSet).sort(),
		permissions: Array.from(permissionSet).sort(),
	}
}

/**
 * Same rows as {@link getUserRolesAndPermissions}, keyed by `users.stable_user_id`
 * so a caller can batch it with the user row it has not read yet.
 */
export function userRolesAndPermissionsByStableIdStatement(
	db: D1Database,
	stableUserId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`SELECT DISTINCT r.name AS role_name, p.action, p.entity, p.access
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 INNER JOIN users u ON u.id = ur.user_id
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 LEFT JOIN permissions p ON p.id = rp.permission_id
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId)
}

/**
 * Bump the personal org's access_epoch so every cached auth decision derived
 * from this user's roles (mcp-auth-cache.ts) misses on the next request.
 * Runs in the same batch as the user_roles write.
 */
function bumpPersonalOrgEpochForUserRowStatement(
	db: D1Database,
	userId: number,
) {
	return db
		.prepare(
			`UPDATE orgs
			 SET access_epoch = access_epoch + 1, updated_at = ?
			 WHERE id = (
			   SELECT stable_user_id FROM users WHERE id = ?${andLiveDeletedAtSql()}
			 )${andLiveDeletedAtSql()}`,
		)
		.bind(new Date().toISOString(), userId)
}

function changesOf(result: D1Result | undefined) {
	return result?.meta?.changes ?? 0
}

export async function getUserRolesAndPermissions(
	db: D1Database,
	userId: number,
): Promise<{ roles: Array<RoleName>; permissions: Array<PermissionString> }> {
	// LEFT JOIN permissions so role membership still resolves when a role has
	// no permission rows yet (background package callers need roles for admin
	// capability discovery and execute-time checks).
	const result = await db
		.prepare(
			`SELECT DISTINCT r.name AS role_name, p.action, p.entity, p.access
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 LEFT JOIN permissions p ON p.id = rp.permission_id
			 WHERE ur.user_id = ?`,
		)
		.bind(userId)
		.all<PermissionRow>()

	return parseUserRolesAndPermissionRows(result.results)
}

/**
 * The site roles and permissions person `stableUserId` holds right now, read
 * from D1 (the background caller's roles are cached). Null when that person
 * is missing, deleted, being deleted, or suspended.
 */
export async function getActiveStableUserRolesAndPermissions(
	db: D1Database,
	stableUserId: string,
): Promise<{
	roles: Array<RoleName>
	permissions: Array<PermissionString>
} | null> {
	const user = await db
		.prepare(
			`SELECT id FROM users
			 WHERE stable_user_id = ?
			   AND suspended_at IS NULL AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ id: number }>()
	if (!user) return null
	return await getUserRolesAndPermissions(db, user.id)
}

function isMissingRbacTableError(error: unknown) {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return (
		message.includes('no such table: user_roles') ||
		message.includes('no such table: roles')
	)
}

/**
 * List stable user ids for every user holding the admin role. Returns an empty
 * list on pre-RBAC databases so callers can treat "no RBAC tables" as "no admins".
 */
export async function listAdminStableUserIds(
	db: D1Database,
): Promise<Array<string>> {
	try {
		const result = await db
			.prepare(
				`SELECT DISTINCT u.stable_user_id
				 FROM users u
				 INNER JOIN user_roles ur ON ur.user_id = u.id
				 INNER JOIN roles r ON r.id = ur.role_id
				 WHERE r.name = 'admin'${andLiveDeletedAtSql()}`,
			)
			.all<{ stable_user_id: string }>()
		return [...new Set((result.results ?? []).map((row) => row.stable_user_id))]
	} catch (error) {
		if (isMissingRbacTableError(error)) return []
		throw error
	}
}

export async function assignUserRole(input: {
	db: D1Database
	userId: number
	roleName: RoleName
}): Promise<{ assigned: boolean }> {
	const [result] = await input.db.batch([
		input.db
			.prepare(
				`INSERT OR IGNORE INTO user_roles (user_id, role_id)
				 SELECT ?, id FROM roles WHERE name = ?`,
			)
			.bind(input.userId, input.roleName),
		bumpPersonalOrgEpochForUserRowStatement(input.db, input.userId),
	])
	return { assigned: changesOf(result) > 0 }
}

export async function removeUserRole(input: {
	db: D1Database
	userId: number
	roleName: RoleName
}) {
	await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM user_roles
				 WHERE user_id = ?
				   AND role_id = (SELECT id FROM roles WHERE name = ?)`,
			)
			.bind(input.userId, input.roleName),
		bumpPersonalOrgEpochForUserRowStatement(input.db, input.userId),
	])
}

/**
 * Removes the admin role from a user only while at least one other admin
 * remains. The count check lives inside the DELETE statement so concurrent
 * removals cannot both pass a stale pre-check and leave zero admins.
 */
export async function removeAdminRolePreservingLastAdmin(input: {
	db: D1Database
	userId: number
}): Promise<{ removed: boolean }> {
	const [result] = await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM user_roles
				 WHERE user_id = ?
				   AND role_id = (SELECT id FROM roles WHERE name = 'admin')
				   AND (
				     SELECT COUNT(DISTINCT ur.user_id)
				     FROM user_roles ur
				     INNER JOIN roles r ON r.id = ur.role_id
				     INNER JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL
				     WHERE r.name = 'admin'
				   ) > 1`,
			)
			.bind(input.userId),
		bumpPersonalOrgEpochForUserRowStatement(input.db, input.userId),
	])
	return { removed: changesOf(result) > 0 }
}

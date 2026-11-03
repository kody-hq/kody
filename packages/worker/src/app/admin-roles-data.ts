import type { AdminRolesLoaderData } from '#universal/loader-data.ts'
import type { PermissionString } from '#universal/permissions.ts'

export async function loadAdminRolesData(
	env: Env,
): Promise<AdminRolesLoaderData> {
	const roleRows = await env.APP_DB.prepare(
		`SELECT name, description FROM roles ORDER BY name ASC`,
	).all<{ name: string; description: string }>()

	const permissionRows = await env.APP_DB.prepare(
		`SELECT r.name AS role_name, p.action, p.entity, p.access
		 FROM roles r
		 INNER JOIN role_permissions rp ON rp.role_id = r.id
		 INNER JOIN permissions p ON p.id = rp.permission_id
		 ORDER BY r.name ASC, p.action ASC, p.entity ASC, p.access ASC`,
	).all<{
		role_name: string
		action: string
		entity: string
		access: string
	}>()

	const permissionsByRole = new Map<string, Array<PermissionString>>()
	for (const row of permissionRows.results ?? []) {
		const permission =
			`${row.action}:${row.entity}:${row.access}` as PermissionString
		const current = permissionsByRole.get(row.role_name) ?? []
		current.push(permission)
		permissionsByRole.set(row.role_name, current)
	}

	return {
		ok: true,
		roles: (roleRows.results ?? []).map((row) => ({
			name: row.name,
			description: row.description,
			permissions: permissionsByRole.get(row.name) ?? [],
		})),
	}
}

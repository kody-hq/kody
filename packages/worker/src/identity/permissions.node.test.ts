import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	buildPermissionString,
	listAdminRolePermissionStrings,
	listRegistryPermissionStrings,
	listUserRolePermissionStrings,
	parsePermissionString,
	roleNames,
	type PermissionAccess,
	type PermissionAction,
	type PermissionEntity,
	type PermissionString,
} from '#universal/permissions.ts'

test('permission registry and migration seed rows stay aligned', () => {
	using db = new DatabaseSync(':memory:')
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))

	type PermissionRow = {
		action: PermissionAction
		entity: PermissionEntity
		access: PermissionAccess
	}
	const seededPermissions = (
		db
			.prepare(`SELECT action, entity, access FROM permissions`)
			.all() as Array<PermissionRow>
	).map((row) => buildPermissionString(row))
	expect(seededPermissions.sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	function listSeededRolePermissionStrings(
		roleName: string,
	): Array<PermissionString> {
		return (
			db
				.prepare(
					`SELECT p.action, p.entity, p.access
					FROM role_permissions rp
					INNER JOIN roles r ON r.id = rp.role_id
					INNER JOIN permissions p ON p.id = rp.permission_id
					WHERE r.name = ?`,
				)
				.all(roleName) as Array<PermissionRow>
		).map((row) => buildPermissionString(row))
	}

	expect(listSeededRolePermissionStrings('user').sort()).toEqual(
		listUserRolePermissionStrings().sort(),
	)
	expect(listUserRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings()
			.filter(
				(permission) => parsePermissionString(permission).access === 'own',
			)
			.sort(),
	)

	expect(listSeededRolePermissionStrings('admin').sort()).toEqual(
		listAdminRolePermissionStrings().sort(),
	)
	expect(listAdminRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	const seededRoleNames = (
		db.prepare(`SELECT name FROM roles`).all() as Array<{ name: string }>
	).map((row) => row.name)
	expect(seededRoleNames.sort()).toEqual([...roleNames].sort())
})

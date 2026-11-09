import { expect, test } from 'vitest'
import { orgPermissions } from './org-permissions.ts'
import {
	isGrantablePermission,
	orgWideManagePermissions,
	orgWideReadPermissions,
	permissionsForGrantPreset,
	resolveGrantPermissions,
} from './grant-presets.ts'

test('use / contribute / manage expand for packages', () => {
	expect(permissionsForGrantPreset('package', 'use')).toEqual([
		'package:read',
		'package:execute',
	])
	expect(permissionsForGrantPreset('package', 'contribute')).toEqual([
		'package:read',
		'package:execute',
		'package:write',
	])
	expect(permissionsForGrantPreset('package', 'manage')).toEqual([
		'package:read',
		'package:execute',
		'package:write',
		'package:delete',
		'package:manage_access',
		'package:publish',
	])
})

test('billing and secret:read are never grantable', () => {
	expect(isGrantablePermission('org', 'billing:write')).toBe(false)
	expect(isGrantablePermission('secret', 'secret:read')).toBe(false)
	expect(isGrantablePermission('package', 'package:read')).toBe(true)
	expect(isGrantablePermission('org', 'package:create')).toBe(true)
})

test('resolveGrantPermissions rejects a non-grantable advanced list', () => {
	expect(() =>
		resolveGrantPermissions({
			family: 'package',
			preset: null,
			permissions: ['billing:write'],
		}),
	).toThrow(/cannot be granted/)
})

test('org grants carry org-wide reads plus package and app manage, and nothing else that writes', () => {
	for (const permission of orgWideReadPermissions) {
		expect(permission.endsWith(':read')).toBe(true)
		expect(isGrantablePermission('org', permission)).toBe(true)
	}
	expect(isGrantablePermission('org', 'secret:read')).toBe(false)
	expect(isGrantablePermission('org', 'memory:read')).toBe(false)
	const grantableResourceActions = orgPermissions.filter(
		(permission) =>
			isGrantablePermission('org', permission) &&
			/^(file|package|app|job|secret|integration|memory|email|execution_context):/.test(
				permission,
			) &&
			!permission.endsWith(':create'),
	)
	expect([...grantableResourceActions].sort()).toEqual(
		[...orgWideReadPermissions, ...orgWideManagePermissions].sort(),
	)
	expect([...orgWideManagePermissions].sort()).toEqual(
		[
			...permissionsForGrantPreset('package', 'manage'),
			...permissionsForGrantPreset('app', 'manage'),
		]
			.filter((permission) => !permission.endsWith(':read'))
			.sort(),
	)
})

test('read is package-only and grants package:read alone', () => {
	expect(permissionsForGrantPreset('package', 'read')).toEqual(['package:read'])
	expect(() => permissionsForGrantPreset('app', 'read')).toThrow(
		/Read preset does not apply/,
	)
})

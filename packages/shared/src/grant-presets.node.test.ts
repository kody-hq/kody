import { expect, test } from 'vitest'
import { orgPermissions } from './org-permissions.ts'
import {
	isGrantablePermission,
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

test('org grants carry read-only resource permissions and nothing that writes', () => {
	for (const permission of orgWideReadPermissions) {
		expect(permission.endsWith(':read')).toBe(true)
		expect(isGrantablePermission('org', permission)).toBe(true)
	}
	expect(isGrantablePermission('org', 'secret:read')).toBe(false)
	expect(isGrantablePermission('org', 'memory:read')).toBe(false)
	const grantableResourceActions = orgPermissions.filter(
		(permission) =>
			isGrantablePermission('org', permission) &&
			/^(package|app|job|secret|integration|memory|email|execution_context):/.test(
				permission,
			) &&
			!permission.endsWith(':create'),
	)
	expect([...grantableResourceActions].sort()).toEqual(
		[...orgWideReadPermissions].sort(),
	)
	for (const permission of [
		'job:write',
		'job:execute',
		'job:delete',
		'job:manage_access',
		'package:write',
		'package:publish',
		'app:execute',
		'secret:use',
		'integration:use',
		'email:send',
		'execution_context:execute',
	] as const) {
		expect(isGrantablePermission('org', permission)).toBe(false)
	}
})

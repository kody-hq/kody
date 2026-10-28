/**
 * Grant presets map to concrete org permissions (Teams spec §5.2). Advanced
 * grants store `preset = NULL` and an explicit permission checklist instead.
 * `billing:*` and `secret:read` are never in a preset.
 *
 * Presets are keyed by permission family. A credential grant uses the family
 * of its credential's kind (`secret` or `integration`).
 */
import { type OrgPermission, type OrgResourceType } from './org-permissions.ts'

export const grantPresets = ['use', 'contribute', 'manage'] as const

export type GrantPreset = (typeof grantPresets)[number]

const useByType: Record<OrgResourceType, ReadonlyArray<OrgPermission>> = {
	package: ['package:read', 'package:execute'],
	app: ['app:read', 'app:execute'],
	job: ['job:read', 'job:execute'],
	secret: ['secret:use'],
	integration: ['integration:use', 'integration:read'],
	memory: ['memory:read'],
	email: ['email:read'],
	execution_context: ['execution_context:read', 'execution_context:execute'],
}

const contributeExtraByType: Record<
	OrgResourceType,
	ReadonlyArray<OrgPermission>
> = {
	package: ['package:write'],
	app: ['app:write'],
	job: ['job:write'],
	secret: ['secret:write'],
	integration: ['integration:write'],
	memory: ['memory:write'],
	email: ['email:send', 'email:write'],
	execution_context: ['execution_context:write'],
}

const manageExtraByType: Record<
	OrgResourceType,
	ReadonlyArray<OrgPermission>
> = {
	package: ['package:delete', 'package:manage_access', 'package:publish'],
	app: ['app:delete', 'app:manage_access'],
	job: ['job:delete', 'job:manage_access'],
	secret: ['secret:delete', 'secret:manage_access'],
	integration: ['integration:delete', 'integration:manage_access'],
	memory: ['memory:delete', 'memory:manage_access'],
	email: ['email:delete', 'email:manage_access'],
	execution_context: [
		'execution_context:delete',
		'execution_context:manage_access',
	],
}

/** Org-level permissions that may appear on an `org` resource grant. */
const orgResourceGrantable: ReadonlyArray<OrgPermission> = [
	'org:read',
	'org:write',
	'org:delete',
	'org:execute',
	'package:create',
	'app:create',
	'job:create',
	'secret:create',
	'integration:create',
	'memory:create',
	'email:create',
	'execution_context:create',
	'search:read',
	'member:read',
	'member:write',
	'member:delete',
	'team:read',
	'team:write',
	'team:delete',
	'audit:read',
	'token:read',
	'token:delete',
]

/**
 * Permissions a grant preset expands to for one resource type. `org` has no
 * presets; callers pass an explicit checklist.
 */
export function permissionsForGrantPreset(
	family: OrgResourceType | 'org',
	preset: GrantPreset,
): ReadonlyArray<OrgPermission> {
	if (family === 'org') {
		throw new Error(
			'Grant presets do not apply to the org resource. Pass an explicit permission list.',
		)
	}
	const use = useByType[family]
	if (preset === 'use') return use
	const contribute = [...use, ...contributeExtraByType[family]]
	if (preset === 'contribute') return contribute
	return [...contribute, ...manageExtraByType[family]]
}

/** True when a permission may be stored on a grant (never billing:*, secret:read). */
export function isGrantablePermission(
	family: OrgResourceType | 'org',
	permission: OrgPermission,
): boolean {
	if (permission === 'billing:read' || permission === 'billing:write') {
		return false
	}
	if (permission === 'secret:read') return false
	if (family === 'org') {
		return orgResourceGrantable.includes(permission)
	}
	const prefix = `${family}:`
	if (!permission.startsWith(prefix)) return false
	const action = permission.slice(prefix.length)
	return action !== 'create'
}

export function resolveGrantPermissions(input: {
	family: OrgResourceType | 'org'
	preset: GrantPreset | null
	permissions: ReadonlyArray<OrgPermission> | null
}): ReadonlyArray<OrgPermission> {
	if (input.preset) {
		return permissionsForGrantPreset(input.family, input.preset)
	}
	const list = input.permissions ?? []
	for (const permission of list) {
		if (!isGrantablePermission(input.family, permission)) {
			throw new Error(
				`Permission ${permission} cannot be granted on ${input.family}.`,
			)
		}
	}
	return list
}

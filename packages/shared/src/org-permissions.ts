/**
 * Org RBAC vocabulary: `resource-type:action` strings. There is no implied
 * hierarchy (`package:execute` without `package:read` is valid). Site-admin
 * roles (`universal/permissions.ts`) are a separate system and never appear
 * here. See docs/contributing/architecture/authorization.md.
 */

const resourceActions = {
	package: ['read', 'execute', 'write', 'delete', 'publish', 'manage_access'],
	app: ['read', 'execute', 'write', 'delete', 'manage_access'],
	job: ['read', 'execute', 'write', 'delete', 'manage_access'],
	// `secret:read` (reveal a value) is reserved: no surface checks it yet.
	secret: ['use', 'read', 'write', 'delete', 'manage_access'],
	integration: ['use', 'read', 'write', 'delete', 'manage_access'],
	memory: ['read', 'write', 'delete', 'manage_access'],
	email: ['read', 'send', 'write', 'delete', 'manage_access'],
	// A registered machine that runs execute. Org roles and org-wide grants
	// confer read, write, delete and manage_access only; `execute` comes from
	// a grant on the context itself (canExecuteOnContext), never from a role.
	// `command` (run host commands, ADR 0093) is never in a preset or role:
	// the operator has it, anyone else needs it granted on the context.
	execution_context: [
		'read',
		'execute',
		'command',
		'write',
		'delete',
		'manage_access',
	],
} as const

/** A permission family: the `resource-type` half of a permission string. */
export type OrgResourceType = keyof typeof resourceActions

/** Permission families that belong to credentials rather than to a resource type of their own. */
export type CredentialPermissionFamily = Extract<
	OrgResourceType,
	'secret' | 'integration'
>

/**
 * What a grant or per-resource check targets. Secrets, OAuth integrations,
 * MCP servers, and vault bindings are one `credential` type keyed by a
 * stable credential id; their permissions keep the `secret:*` and
 * `integration:*` families.
 */
export type OrgGrantResourceType =
	| Exclude<OrgResourceType, CredentialPermissionFamily>
	| 'credential'

const orgResourceTypes = Object.keys(resourceActions) as Array<OrgResourceType>

export function isOrgResourceType(value: unknown): value is OrgResourceType {
	return (
		typeof value === 'string' &&
		(orgResourceTypes as ReadonlyArray<string>).includes(value)
	)
}

export function isOrgGrantResourceType(
	value: unknown,
): value is OrgGrantResourceType {
	if (value === 'credential') return true
	return (
		isOrgResourceType(value) && value !== 'secret' && value !== 'integration'
	)
}

type ResourcePermission = {
	[Type in OrgResourceType]: `${Type}:${(typeof resourceActions)[Type][number]}`
}[OrgResourceType]

type CreatePermission = `${OrgResourceType}:create`

const orgLevelPermissionList = [
	'org:read',
	'org:write',
	'org:delete',
	'org:execute',
	'search:read',
	'member:read',
	'member:write',
	'member:delete',
	'team:read',
	'team:write',
	'team:delete',
	'billing:read',
	'billing:write',
	'audit:read',
	'token:read',
	'token:delete',
	'profile:manage',
] as const

export type OrgPermission =
	| ResourcePermission
	| CreatePermission
	| (typeof orgLevelPermissionList)[number]

export const orgPermissions: ReadonlyArray<OrgPermission> = [
	...orgResourceTypes.flatMap((type) =>
		resourceActions[type].map(
			(action) => `${type}:${action}` as ResourcePermission,
		),
	),
	...orgResourceTypes.map((type) => `${type}:create` as CreatePermission),
	...orgLevelPermissionList,
]

const orgPermissionSet: ReadonlySet<string> = new Set(orgPermissions)

export function isOrgPermission(value: unknown): value is OrgPermission {
	return typeof value === 'string' && orgPermissionSet.has(value)
}

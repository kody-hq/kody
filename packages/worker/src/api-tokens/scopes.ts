/**
 * API token scopes are org permissions (`resource-type:action`). There is no
 * implied hierarchy: holding `package:write` does not grant `package:read`.
 * See `org-permissions.ts` and docs/contributing/architecture/authorization.md.
 */
import {
	isOrgPermission,
	orgPermissions,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'

export type ApiTokenScope = OrgPermission

export const isApiTokenScope = isOrgPermission

export const apiTokenScopes: ReadonlyArray<ApiTokenScope> = orgPermissions

const keyScopeDescriptions: Partial<Record<OrgPermission, string>> = {
	'org:read': 'Read this org’s profile, members, and billing summary.',
	'org:write': 'Change this org’s profile and settings.',
	'org:delete': 'Delete this org.',
	'org:execute':
		'Run execute and local CapabilityProxy hops for this org (API tokens need this scope; CLI `kody login` OAuth is a separate credential).',
	'search:read': 'Run unified Kody search.',
	'member:read': 'Read org members.',
	'member:write': 'Invite and change org members.',
	'member:delete': 'Remove org members.',
	'team:read': 'Read teams.',
	'team:write': 'Create and change teams.',
	'team:delete': 'Delete teams.',
	'billing:read': 'Read billing and plan.',
	'billing:write': 'Change billing and plan.',
	'audit:read': 'Read the org audit log.',
	'token:read': 'List and inspect API tokens.',
	'token:delete': 'Revoke API tokens.',
	'profile:manage':
		'Create, list, shorten, and revoke your profiles (Owners: list and revoke any profile in the org).',
	'package:read': 'Read saved packages and package-backed resources.',
	'package:execute': 'Execute saved packages.',
	'package:write': 'Change saved packages and package-backed resources.',
	'package:create': 'Create saved packages.',
	'package:delete': 'Delete saved packages.',
	'package:publish': 'Publish packages to the community catalog.',
	'package:manage_access': 'Manage package access grants.',
	'secret:use': 'Use secrets without reading plaintext.',
	'secret:write': 'Change existing secrets (plaintext is never returned).',
	'secret:create': 'Create new secrets.',
	'memory:read': 'Read memories and MCP server instructions.',
	'memory:write': 'Change existing memories.',
	'memory:create': 'Create new memories.',
	'job:read': 'Read package jobs and workflow runs.',
	'job:execute': 'Run package jobs.',
	'email:read': 'Read inboxes and messages.',
	'email:send': 'Send email.',
	'integration:read': 'Read OAuth integrations and connected MCP servers.',
	'integration:use': 'Use connected integrations.',
	'app:read': 'Read package apps.',
	'app:execute': 'Run package apps.',
}

export const apiTokenScopeDescriptions: Record<ApiTokenScope, string> =
	Object.fromEntries(
		orgPermissions.map((permission) => [
			permission,
			keyScopeDescriptions[permission] ??
				`Granted \`${permission}\` in this org.`,
		]),
	) as Record<ApiTokenScope, string>

/** True when `granted` lists `required` exactly. Org permissions have no hierarchy. */
export function apiTokenScopeIncludes(
	granted: ReadonlyArray<ApiTokenScope>,
	required: ApiTokenScope,
) {
	return granted.includes(required)
}

/** Sorted, de-duplicated org-permission scopes; throws on unknown values. */
export function normalizeApiTokenScopes(values: ReadonlyArray<unknown>) {
	const unknown = values.filter((value) => !isOrgPermission(value))
	if (unknown.length > 0) {
		throw new Error(
			`Unknown API token scope(s): ${unknown.map(String).join(', ')}.`,
		)
	}
	return [...new Set(values as ReadonlyArray<ApiTokenScope>)].sort()
}

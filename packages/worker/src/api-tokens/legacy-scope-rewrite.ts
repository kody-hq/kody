/**
 * Teams P4 §5.3: expand pre-org API token scopes to `OrgPermission` strings.
 * Unknown values fail loudly. Already-valid org permissions pass through so
 * the rewrite is idempotent after 0090.
 *
 * `local-execute` expands to the use-level org permissions CapabilityProxy
 * needed for saved packages (integrations, secrets, email, jobs, …). 0090
 * only mapped it to `org:execute`; 0092 repairs stored tokens. Keep this list
 * in sync with `cliCredentialBootstrapNarrowScopes` (plus `org:read`).
 *
 * The 0090 SQL header also names a companion
 * `tools/teams-migration/rewrite-api-token-scopes.ts`. That tool was deleted
 * (#3365) and the applied migration's bytes are immutable under
 * `tools/migration-ledger/`, so this module and the SQL in 0090 are the
 * only copies of the map. `jobs:write` here no longer expands to `job:delete`
 * (`jobDelete` is gone, #3422). Applied 0090 rows stay as written.
 */
import {
	isOrgPermission,
	type OrgPermission,
	withoutRetiredOrgPermissions,
} from '@kody-internal/shared/org-permissions.ts'

/**
 * Org permissions that pre-P4 `local-execute` effectively granted through
 * CapabilityProxy (route gate was the only scope check). Sorted.
 * `search:read` stays out — agents use MCP `search` or an explicit grant.
 */
export const localExecuteOrgPermissions = [
	'app:execute',
	'app:read',
	'email:read',
	'email:send',
	'integration:read',
	'integration:use',
	'job:execute',
	'job:read',
	'memory:read',
	'org:execute',
	'package:execute',
	'package:read',
	'secret:use',
] as const satisfies ReadonlyArray<OrgPermission>

const localExecuteOrgPermissionSet: ReadonlySet<OrgPermission> = new Set(
	localExecuteOrgPermissions,
)

/**
 * When a token already holds `org:execute`, ensure it also holds the
 * local-execute parity set. Idempotent. Used by migration 0092 repair and
 * bootstrap defaults (via the same constant).
 */
export function unionLocalExecuteParityScopes(
	scopes: ReadonlyArray<OrgPermission>,
): Array<OrgPermission> {
	if (!scopes.includes('org:execute')) return [...scopes].sort()
	const next = new Set<OrgPermission>(scopes)
	for (const permission of localExecuteOrgPermissionSet) {
		next.add(permission)
	}
	return [...next].sort()
}

/**
 * Same targets as migration 0092: CLI bootstrap *tokens*, or tokens that
 * still look like the incomplete 0090 `local-execute` → `org:execute`
 * rewrite (hold `org:execute` but not `package:execute`). Intentional CI
 * tokens that already list `package:execute` are left alone. Outstanding
 * bootstrap *codes* are not repaired (short TTL; parent-cap risk).
 */
export function shouldRepairLocalExecuteParity(input: {
	scopes: ReadonlyArray<string>
	createdVia?: string | null
}): boolean {
	if (!input.scopes.includes('org:execute')) return false
	if (input.createdVia === 'cli-bootstrap') return true
	return !input.scopes.includes('package:execute')
}

const accountRead = [
	'billing:read',
	'member:read',
	'org:read',
] as const satisfies ReadonlyArray<OrgPermission>

const memoriesRead = [
	'memory:read',
] as const satisfies ReadonlyArray<OrgPermission>

const secretsRead = [
	'secret:use',
] as const satisfies ReadonlyArray<OrgPermission>

const packagesRead = [
	'app:execute',
	'app:read',
	'package:execute',
	'package:read',
] as const satisfies ReadonlyArray<OrgPermission>

const reposRead = [
	'package:read',
] as const satisfies ReadonlyArray<OrgPermission>

const jobsRead = ['job:read'] as const satisfies ReadonlyArray<OrgPermission>

const webhooksRead = [
	'package:read',
] as const satisfies ReadonlyArray<OrgPermission>

const emailRead = ['email:read'] as const satisfies ReadonlyArray<OrgPermission>

const integrationsRead = [
	'integration:read',
] as const satisfies ReadonlyArray<OrgPermission>

const runsRead = [
	'job:read',
	'package:read',
] as const satisfies ReadonlyArray<OrgPermission>

const storageRead = [
	'package:read',
] as const satisfies ReadonlyArray<OrgPermission>

const communityRead = [
	'org:read',
] as const satisfies ReadonlyArray<OrgPermission>

const tokensRead = [
	'token:read',
] as const satisfies ReadonlyArray<OrgPermission>

/**
 * Fixed §5.3 map. Values are the expanded org-permission set for one legacy
 * scope. Write scopes include the matching read set.
 */
export const legacyApiTokenScopeMap = {
	'account:read': [...accountRead],
	'account:write': [...accountRead, 'org:write', 'billing:write'],
	'memories:read': [...memoriesRead],
	'memories:write': [
		...memoriesRead,
		'memory:write',
		'memory:delete',
		'memory:create',
	],
	'secrets:read': [...secretsRead],
	'secrets:write': [
		...secretsRead,
		'secret:write',
		'secret:delete',
		'secret:create',
	],
	'packages:read': [...packagesRead],
	'packages:write': [
		...packagesRead,
		'package:write',
		'package:delete',
		'package:create',
		'package:manage_access',
		'app:write',
		'app:delete',
	],
	'repos:read': [...reposRead],
	'repos:write': [...reposRead, 'package:write'],
	'jobs:read': [...jobsRead],
	'jobs:write': [...jobsRead, 'job:execute', 'job:write'],
	'webhooks:read': [...webhooksRead],
	'webhooks:write': [...webhooksRead, 'package:write'],
	'email:read': [...emailRead],
	'email:write': [...emailRead, 'email:send', 'email:write', 'email:delete'],
	'integrations:read': [...integrationsRead],
	'integrations:write': [
		...integrationsRead,
		'integration:use',
		'integration:write',
		'integration:delete',
		'integration:create',
	],
	'mcp-servers:read': [...integrationsRead],
	'mcp-servers:write': [
		...integrationsRead,
		'integration:use',
		'integration:write',
		'integration:delete',
		'integration:create',
	],
	'runs:read': [...runsRead],
	'runs:write': [...runsRead, 'job:execute'],
	'storage:read': [...storageRead],
	'storage:write': [...storageRead, 'package:write'],
	'community:read': [...communityRead],
	'community:write': [...communityRead, 'package:publish'],
	'tokens:read': [...tokensRead],
	'tokens:write': [...tokensRead, 'token:delete'],
	'search:read': ['search:read'],
	'local-execute': [...localExecuteOrgPermissions],
} as const satisfies Record<string, ReadonlyArray<OrgPermission>>

export type LegacyApiTokenScope = keyof typeof legacyApiTokenScopeMap

const legacyApiTokenScopeSet: ReadonlySet<string> = new Set(
	Object.keys(legacyApiTokenScopeMap),
)

export function isLegacyApiTokenScope(
	value: unknown,
): value is LegacyApiTokenScope {
	return typeof value === 'string' && legacyApiTokenScopeSet.has(value)
}

/**
 * Expand, de-duplicate, and sort. Throws when a value is neither a known
 * legacy scope nor an org permission.
 */
export function rewriteLegacyApiTokenScopes(
	scopes: ReadonlyArray<string>,
): Array<OrgPermission> {
	const rewritten = new Set<OrgPermission>()
	const unknown: Array<string> = []
	for (const scope of withoutRetiredOrgPermissions(scopes)) {
		if (isLegacyApiTokenScope(scope)) {
			for (const permission of legacyApiTokenScopeMap[scope]) {
				rewritten.add(permission)
			}
			continue
		}
		if (isOrgPermission(scope)) {
			rewritten.add(scope)
			continue
		}
		unknown.push(scope)
	}
	if (unknown.length > 0) {
		throw new Error(`Unknown legacy API token scope(s): ${unknown.join(', ')}.`)
	}
	return [...rewritten].sort()
}

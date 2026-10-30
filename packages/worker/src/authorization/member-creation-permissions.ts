import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'

/**
 * What a team org lets every Member create without a grant. Owners always
 * can. `packages` covers saved packages, repos, and their apps; `credentials`
 * covers secrets, OAuth connections, and MCP servers.
 */
export type OrgMemberCreation = {
	packages: boolean
	credentials: boolean
}

export const defaultOrgMemberCreation: OrgMemberCreation = {
	packages: false,
	credentials: true,
}

export const memberCreationPermissions = {
	packages: ['package:create', 'app:create'],
	credentials: ['secret:create', 'integration:create'],
} as const satisfies Record<
	keyof OrgMemberCreation,
	ReadonlyArray<OrgPermission>
>

export type MemberCreationPermission =
	(typeof memberCreationPermissions)[keyof OrgMemberCreation][number]

export function memberCreationKindFor(
	permission: OrgPermission,
): keyof OrgMemberCreation | null {
	for (const kind of ['packages', 'credentials'] as const) {
		if (
			(
				memberCreationPermissions[kind] as ReadonlyArray<OrgPermission>
			).includes(permission)
		) {
			return kind
		}
	}
	return null
}

/** The org-level permissions every Member holds from these settings. */
export function memberCreationGrants(
	settings: OrgMemberCreation,
): Array<OrgPermission> {
	return [
		...(settings.packages ? memberCreationPermissions.packages : []),
		...(settings.credentials ? memberCreationPermissions.credentials : []),
	]
}

export type MemberCreationRow = {
	members_can_create_packages: number | null
	members_can_create_credentials: number | null
}

export function memberCreationFromRow(
	row: MemberCreationRow | null | undefined,
): OrgMemberCreation {
	if (!row) return { ...defaultOrgMemberCreation }
	return {
		packages:
			row.members_can_create_packages == null
				? defaultOrgMemberCreation.packages
				: Number(row.members_can_create_packages) === 1,
		credentials:
			row.members_can_create_credentials == null
				? defaultOrgMemberCreation.credentials
				: Number(row.members_can_create_credentials) === 1,
	}
}

import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'

export type OrgCreatePermission = Extract<
	OrgPermission,
	'package:create' | 'secret:create' | 'integration:create'
>

/** Labels for the create permissions an organization grant may carry. */
export const orgCreateAccessOptions: ReadonlyArray<{
	permission: OrgCreatePermission
	label: string
	description: string
}> = [
	{
		permission: 'package:create',
		label: 'Packages and apps',
		description:
			'Save new packages and repositories, including their apps, and publish them for the first time.',
	},
	{
		permission: 'secret:create',
		label: 'Secrets',
		description: 'Add new secrets for this organization.',
	},
	{
		permission: 'integration:create',
		label: 'Connections and MCP servers',
		description:
			'Connect new OAuth accounts and add new MCP servers for this organization.',
	},
]

export function isOrgCreatePermission(
	permission: unknown,
): permission is OrgCreatePermission {
	return orgCreateAccessOptions.some(
		(option) => option.permission === permission,
	)
}

export function orgCreateAccessLabel(permission: string) {
	return (
		orgCreateAccessOptions.find((option) => option.permission === permission)
			?.label ?? null
	)
}

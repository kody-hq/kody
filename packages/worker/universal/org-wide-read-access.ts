import {
	orgWideReadPermissions,
	type OrgWideReadPermission,
} from '@kody-internal/shared/grant-presets.ts'

/** Labels for the read-only permissions an organization grant may carry. */
export const orgWideReadAccessOptions: ReadonlyArray<{
	permission: OrgWideReadPermission
	label: string
	description: string
}> = [
	{
		permission: 'job:read',
		label: 'Jobs and run history',
		description:
			'Every job, workflow, and run in this organization, with run logs.',
	},
	{
		permission: 'app:read',
		label: 'Package apps',
		description: 'Every package app and its sessions.',
	},
	{
		permission: 'package:read',
		label: 'Packages and repositories',
		description: 'Source, skills, and checks for every package and repo.',
	},
	{
		permission: 'integration:read',
		label: 'Credentials',
		description:
			'Which integrations and MCP servers exist and where they connect. Never a token or secret value.',
	},
	{
		permission: 'email:read',
		label: 'Email',
		description:
			'Every inbox and message, including any sign-in codes they receive.',
	},
]

if (orgWideReadAccessOptions.length !== orgWideReadPermissions.length) {
	throw new Error('Every org-wide read permission needs a label.')
}

export function orgWideReadAccessLabel(permission: string) {
	return (
		orgWideReadAccessOptions.find((option) => option.permission === permission)
			?.label ?? null
	)
}

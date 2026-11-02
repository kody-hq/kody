import {
	type OrgWideManagePermission,
	type OrgWideReadPermission,
} from '@kody-internal/shared/grant-presets.ts'

/**
 * Org-wide Manage, one option per resource kind. Saving an option also grants
 * that kind's read permission; removing it leaves the read in place.
 */
export const orgWideManageAccessOptions: ReadonlyArray<{
	permission: 'package' | 'app'
	label: string
	description: string
	read: OrgWideReadPermission
	permissions: ReadonlyArray<OrgWideManagePermission>
}> = [
	{
		permission: 'package',
		label: 'Every package and repository',
		description:
			'Run, change, publish, delete, and share every package and repo in this organization, including ones created later. Packages with unmappable credentials stay owner-only to change unless an Owner allows changes on that package.',
		read: 'package:read',
		permissions: [
			'package:execute',
			'package:write',
			'package:publish',
			'package:delete',
			'package:manage_access',
		],
	},
	{
		permission: 'app',
		label: 'Every package app',
		description:
			'Open, change, delete, and share every package app in this organization, including ones created later.',
		read: 'app:read',
		permissions: [
			'app:execute',
			'app:write',
			'app:delete',
			'app:manage_access',
		],
	},
]

/** Options whose every manage permission is in `held`. */
export function heldOrgWideManageOptions(held: ReadonlyArray<string>) {
	return orgWideManageAccessOptions
		.filter((option) =>
			option.permissions.every((permission) => held.includes(permission)),
		)
		.map((option) => option.permission)
}

/**
 * Manage permissions to save for the chosen options; the server adds each
 * read. An unchosen option keeps what `held` has of it unless `held` had all
 * of it, so saving one kind never drops a partial grant on the other.
 */
export function orgWideManagePermissionsFor(
	options: ReadonlyArray<string>,
	held: ReadonlyArray<string> = [],
) {
	return orgWideManageAccessOptions.flatMap((option) => {
		if (options.includes(option.permission)) return [...option.permissions]
		const partial = option.permissions.filter((permission) =>
			held.includes(permission),
		)
		return partial.length === option.permissions.length ? [] : partial
	})
}

export function orgWideManageAccessLabel(permission: string) {
	return (
		orgWideManageAccessOptions.find((option) =>
			option.permissions.some((held) => held === permission),
		)?.label ?? null
	)
}

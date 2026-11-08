import type { OrgGrantView } from '#universal/loader-data.ts'
import { orgCreateAccessLabel } from '#universal/org-create-access.ts'
import {
	heldOrgWideManageOptions,
	orgWideManageAccessLabel,
	orgWideManageAccessOptions,
} from '#universal/org-wide-manage-access.ts'
import { orgWideReadAccessLabel } from '#universal/org-wide-read-access.ts'

type GrantLike = Pick<OrgGrantView, 'resourceType' | 'permissions' | 'preset'>

export function resourceTypeLabel(resourceType: string) {
	switch (resourceType) {
		case 'org':
			return 'Organization'
		case 'package':
			return 'Package'
		case 'app':
			return 'Package app'
		case 'job':
			return 'Job'
		case 'credential':
			return 'Credential'
		case 'memory':
			return 'Memory'
		case 'email':
			return 'Email'
		case 'execution_context':
			return 'Execution context'
		default:
			return resourceType
	}
}

const resourceTypeNouns: Record<string, [string, string]> = {
	package: ['package', 'packages'],
	app: ['app', 'apps'],
	credential: ['credential', 'credentials'],
	job: ['job', 'jobs'],
	memory: ['memory', 'memories'],
	email: ['email inbox', 'email inboxes'],
	execution_context: ['execution context', 'execution contexts'],
}

const resourceTypeOrder = ['org', ...Object.keys(resourceTypeNouns)]

/** Resource types the Grants filters know; anything else is `other`. */
const filteredResourceTypes = ['package', 'app', 'credential', 'org']

export function resourceFilterType(resourceType: string) {
	return filteredResourceTypes.includes(resourceType) ? resourceType : 'other'
}

/** Space-separated filter types a subject's grants cover. */
export function grantedTypes(grants: ReadonlyArray<GrantLike>) {
	return [
		...new Set(grants.map((grant) => resourceFilterType(grant.resourceType))),
	].join(' ')
}

function plural(count: number, [one, many]: [string, string]) {
	return `${count} ${count === 1 ? one : many}`
}

/** Distinct permissions across a subject's organization grants. */
function orgPermissionCount(grants: ReadonlyArray<GrantLike>) {
	return new Set(
		grants
			.filter((grant) => grant.resourceType === 'org')
			.flatMap((grant) => grant.permissions),
	).size
}

/**
 * One line per subject: "Org: 9 permissions, 14 packages, 2 apps". Organization
 * grants count distinct permissions; every other type counts grants.
 */
export function grantCountsSummary(grants: ReadonlyArray<GrantLike>) {
	const counts = new Map<string, number>()
	for (const grant of grants) {
		if (grant.resourceType === 'org') continue
		const type =
			grant.resourceType in resourceTypeNouns ? grant.resourceType : 'other'
		counts.set(type, (counts.get(type) ?? 0) + 1)
	}
	const parts = [...counts.entries()]
		.sort(
			([a], [b]) =>
				(resourceTypeOrder.indexOf(a) >>> 0) -
				(resourceTypeOrder.indexOf(b) >>> 0),
		)
		.map(([type, count]) =>
			plural(count, resourceTypeNouns[type] ?? ['other grant', 'other grants']),
		)
	if (grants.some((grant) => grant.resourceType === 'org')) {
		parts.unshift(
			`Org: ${plural(orgPermissionCount(grants), ['permission', 'permissions'])}`,
		)
	}
	return parts.join(', ')
}

export type PermissionGroup = { label: string; items: Array<string> }

/**
 * Organization grant permissions in plain words, grouped as Manage, Create,
 * Read, and anything without a label yet.
 */
export function orgPermissionGroups(
	permissions: ReadonlyArray<string>,
): Array<PermissionGroup> {
	const held = heldOrgWideManageOptions(permissions)
	const manages = orgWideManageAccessOptions
		.filter((option) => held.includes(option.permission))
		.map((option) => option.label)
	const creates = permissions.flatMap(
		(permission) => orgCreateAccessLabel(permission) ?? [],
	)
	const reads = permissions.flatMap(
		(permission) => orgWideReadAccessLabel(permission) ?? [],
	)
	const other = permissions.filter(
		(permission) =>
			!orgWideReadAccessLabel(permission) &&
			!orgCreateAccessLabel(permission) &&
			!(
				orgWideManageAccessLabel(permission) &&
				manages.includes(orgWideManageAccessLabel(permission) ?? '')
			),
	)
	return [
		{ label: 'Manage', items: manages },
		{ label: 'Create', items: creates },
		{ label: 'Read', items: reads },
		{ label: 'Other', items: other },
	].filter((group) => group.items.length > 0)
}

/**
 * A grant's access in a few words. A preset is its label; an explicit list is
 * a count with the first group named, so a long list stays one short line.
 */
export function grantAccessSummary(
	grant: GrantLike & { presetLabel: string | null },
) {
	if (grant.presetLabel) return grant.presetLabel
	if (grant.permissions.length === 0) return 'No permissions'
	const groups =
		grant.resourceType === 'org'
			? orgPermissionGroups(grant.permissions)
			: [{ label: 'Custom', items: [...grant.permissions] }]
	const count = plural(grant.permissions.length, ['permission', 'permissions'])
	const first = groups[0]
	if (!first) return count
	return `${count} · ${first.label}: ${first.items[0]}${
		first.items.length > 1 || groups.length > 1 ? ', and more' : ''
	}`
}

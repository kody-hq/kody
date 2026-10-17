import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	orgBillingPath,
	orgCollaboratorsPath,
	orgCreditsPath,
	orgGrantsPath,
	orgMembersPath,
	orgOverviewPath,
	orgResourcePath,
	orgRoleManagesBilling,
	orgSettingsPath,
	orgTeamsPath,
	orgUsagePath,
	type OrganizationSummary,
	type WorkspaceSwitchTarget,
	isOrganizationSlug,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { type IconName } from '#universal/icon-names.ts'

/**
 * The repository list for an organization. Without a slug yet, the link
 * opens the person hub instead of a removed `/account/packages` page.
 */
function accountPackagesNavHref(orgSlug: string | null | undefined) {
	return orgSlug
		? orgResourcePath(orgSlug, 'repositories')
		: routes.account.href()
}

function orgSectionHref(
	orgSlug: string | null | undefined,
	section: OrgOwnedAccountSection,
) {
	return orgSlug ? orgResourcePath(orgSlug, section) : routes.account.href()
}

/** Matched workspace identity wins, then the stable signup slug, then username. */
export function accountRailOrgSlug(input: {
	orgSlug: string | null
	organizations: ReadonlyArray<{ slug: string; personal: boolean }>
	username: string | null | undefined
}) {
	return (
		input.orgSlug ??
		input.organizations.find((org) => org.personal)?.slug ??
		input.username?.trim() ??
		null
	)
}

/** One page of a rail item that has several (Activity → Workflows). */
export type AccountRailTab = {
	id: string
	href: string
	label: string
}

export type AccountRailItem = {
	id: string
	href: string
	label: string
	icon: IconName
	/** One line for the workspace overview card. */
	description?: string
	/**
	 * Sibling pages shown as tabs under the page title. Each tab page also
	 * marks this item current, so the rail lists the group once.
	 */
	tabs?: ReadonlyArray<AccountRailTab>
}

export type AccountRailGroup = {
	label: string | null
	items: Array<AccountRailItem>
	/**
	 * Short explanation when role permissions hide the rest of this group
	 * (grant-only collaborators). Shown in the rail; never used to hide a
	 * section that the server would open for a member role.
	 */
	note?: string
}

/** Settings that belong to the person, whichever organization they are in. */
const accountRailItems: Array<AccountRailItem> = [
	{
		id: 'profile',
		href: routes.account.href(),
		label: 'Account settings',
		icon: 'user',
	},
	{
		href: routes.accountSecurity.href(),
		id: 'security',
		label: 'Security',
		icon: 'shield',
	},
	{
		href: routes.accountOrganizations.href(),
		id: 'organizations',
		label: 'Organizations',
		icon: 'users',
	},
	{
		href: routes.accountExperiments.href(),
		id: 'experiments',
		label: 'Experiments',
		icon: 'star',
	},
	{
		href: routes.accountData.href(),
		id: 'data',
		label: 'Data & deletion',
		icon: 'folder',
	},
]

/**
 * Where an organization's workspace opens: a team org's home at `/@slug`,
 * or the signup org's `/@slug/-/overview` (its `/@slug` is the public
 * profile).
 */
export function workspaceHomeHref(org: { slug: string; personal: boolean }) {
	return org.personal
		? orgOverviewPath(org.slug)
		: routes.profile.href({ username: org.slug })
}

/** Target policy is presentation only; destination loaders authorize every request. */
export function workspaceSwitchHref(
	target: WorkspaceSwitchTarget | undefined,
	org: Pick<OrganizationSummary, 'slug' | 'personal' | 'role'>,
) {
	if (!isOrganizationSlug(org.slug)) return '/'
	if (!target) return workspaceHomeHref(org)
	const { section, rest } = target
	if (section !== 'credits' && org.role === null && section !== 'agents')
		return workspaceHomeHref(org)
	if (
		(section === 'billing' || section === 'usage') &&
		!orgRoleManagesBilling(org.role)
	)
		return workspaceHomeHref(org)
	const management = [
		'settings',
		'members',
		'teams',
		'grants',
		'collaborators',
	].includes(section)
	if (management && org.personal && section !== 'grants')
		return workspaceHomeHref(org)
	if (section === 'teams' && org.role === 'billing')
		return workspaceHomeHref(org)
	return `/@${org.slug}/-/${section}${rest ? `/${rest}` : ''}`
}

/**
 * The account rail: only the settings that belong to the person. Workspaces
 * are reached from the avatar menu's Manage group and the Organizations page,
 * not listed here.
 */
export function accountRailGroups(): Array<AccountRailGroup> {
	return [{ label: null, items: accountRailItems }]
}

function overviewRailItem(
	orgSlug: string | null | undefined,
	personal = true,
): AccountRailItem {
	if (!orgSlug) {
		return {
			href: routes.account.href(),
			id: 'overview',
			label: 'Overview',
			icon: 'home',
			description: 'Every section this workspace owns, one click away.',
		}
	}
	// Team orgs already use `/@slug` as their overview (the server redirects
	// `/-/overview` there). Link straight to the home so a refresh keeps it.
	if (!personal) {
		return {
			href: routes.profile.href({ username: orgSlug }),
			id: 'overview',
			label: 'Overview',
			icon: 'home',
			description: 'Every section this workspace owns, one click away.',
		}
	}
	return {
		href: orgOverviewPath(orgSlug),
		id: 'overview',
		label: 'Overview',
		icon: 'home',
		description: 'Every section this workspace owns, one click away.',
	}
}

function billingRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgBillingPath(orgSlug) : routes.account.href(),
		id: 'billing',
		label: 'Billing',
		icon: 'wallet',
	}
}

function usageRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgUsagePath(orgSlug) : routes.account.href(),
		id: 'usage',
		label: 'Usage',
		icon: 'chart',
	}
}

function creditsRailItem(orgSlug: string): AccountRailItem {
	return {
		href: orgCreditsPath(orgSlug),
		id: 'credits',
		label: 'Credits',
		icon: 'pie-chart',
	}
}

/**
 * Entry into an organization's workspace rail. Lands on Repositories (the
 * first Build section) so Activity, Secrets, and the rest stay one click away
 * on the existing `/@slug/-/<section>` rail — not a second navigation system.
 */
export function workspaceLandingItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: accountPackagesNavHref(orgSlug),
		id: 'workspace',
		label: 'Workspace',
		icon: 'box',
	}
}

/**
 * Management links for a team (non-personal) organization. Same order as the
 * Organization rail: Settings, Members, Teams (owners/members), Grants,
 * Collaborators, Usage and Billing (owners/billing), and Credits (every
 * member). Empty for collaborators (`role` null) or when `orgSlug` is missing. Used by the rail and org home so
 * discovery stays consistent.
 */
export function teamOrgManagementItems(input: {
	orgSlug: string | null | undefined
	role: OrgRole | null
}): Array<AccountRailItem> {
	const { orgSlug } = input
	if (!orgSlug || input.role === null) return []
	const items: Array<AccountRailItem> = [
		{
			href: orgSettingsPath(orgSlug),
			id: 'settings',
			label: 'Settings',
			icon: 'edit',
		},
		{
			href: orgMembersPath(orgSlug),
			id: 'members',
			label: 'Members',
			icon: 'users',
		},
	]
	// Billing has member:read but not team:read.
	if (input.role === 'owner' || input.role === 'member') {
		items.push({
			href: orgTeamsPath(orgSlug),
			id: 'teams',
			label: 'Teams',
			icon: 'users',
		})
	}
	items.push(
		{
			href: orgGrantsPath(orgSlug),
			id: 'grants',
			label: 'Grants',
			icon: 'key',
		},
		{
			href: orgCollaboratorsPath(orgSlug),
			id: 'collaborators',
			label: 'Collaborators',
			icon: 'share',
		},
	)
	if (orgRoleManagesBilling(input.role)) {
		items.push(
			usageRailItem(orgSlug),
			creditsRailItem(orgSlug),
			billingRailItem(orgSlug),
		)
	} else {
		items.push(creditsRailItem(orgSlug))
	}
	return items
}

function repositoriesRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: accountPackagesNavHref(orgSlug),
		id: 'repositories',
		label: 'Repositories',
		icon: 'box',
		description: 'Every repository in this workspace, private ones included.',
	}
}

function jobsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'jobs'),
		id: 'jobs',
		label: 'Jobs',
		icon: 'briefcase',
		description: 'Scheduled package jobs. Run one now or pause it.',
	}
}

function agentsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'agents'),
		id: 'agents',
		label: 'Agents',
		icon: 'link',
		description: 'Agents connected to Kody and what they can use.',
	}
}

/**
 * One home for every credential kind. The Key, OAuth, and MCP server editors
 * still live on their own pages, so those count as Credentials too.
 */
function credentialsRailItem(
	orgSlug: string | null | undefined,
): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'credentials'),
		id: 'credentials',
		label: 'Credentials',
		icon: 'key',
		description:
			'Keys, OAuth connections, MCP servers, and vaults Kody uses for you.',
	}
}

function memoriesRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSectionHref(orgSlug, 'memories'),
		id: 'memories',
		label: 'Memories',
		icon: 'book',
		description: 'Personal long-term memories for this account.',
	}
}

function activityRailItem(orgSlug: string | null | undefined): AccountRailItem {
	const tabs: Array<AccountRailTab> = [
		{
			href: orgSectionHref(orgSlug, 'activity'),
			id: 'activity',
			label: 'Activity',
		},
		{
			href: orgSectionHref(orgSlug, 'workflows'),
			id: 'workflows',
			label: 'Workflows',
		},
		{
			href: orgSectionHref(orgSlug, 'waiting'),
			id: 'waiting',
			label: 'Waiting',
		},
	]
	return {
		href: orgSectionHref(orgSlug, 'activity'),
		id: 'activity',
		label: 'Activity',
		icon: 'trending-up',
		description:
			'Recent runs with their logs, long-running workflows, and what is waiting on you.',
		tabs,
	}
}

function grantsRailItem(orgSlug: string | null | undefined): AccountRailItem {
	return {
		href: orgSlug ? orgGrantsPath(orgSlug) : routes.account.href(),
		id: 'grants',
		label: 'Grants',
		icon: 'key',
		description: 'Who can use packages and other resources in this workspace.',
	}
}

/**
 * Members of a team org, with Teams, Collaborators, and Grants as tabs. Teams
 * needs `team:read`, which the Billing role does not have.
 */
function membersRailItem(orgSlug: string, role: OrgRole): AccountRailItem {
	const tabs: Array<AccountRailTab> = [
		{ href: orgMembersPath(orgSlug), id: 'members', label: 'Members' },
		...(role === 'owner' || role === 'member'
			? [{ href: orgTeamsPath(orgSlug), id: 'teams', label: 'Teams' }]
			: []),
		{
			href: orgCollaboratorsPath(orgSlug),
			id: 'collaborators',
			label: 'Collaborators',
		},
		{ href: orgGrantsPath(orgSlug), id: 'grants', label: 'Grants' },
	]
	return {
		href: orgMembersPath(orgSlug),
		id: 'members',
		label: 'Members',
		icon: 'users',
		description: 'People, teams, collaborators, and what each can use.',
		tabs,
	}
}

/**
 * Workspace sections shared by personal and team orgs, except Memories
 * (personal-only after ADR 0072). The server opens each of them for member
 * roles (`orgSectionDenial` only closes grant-only collaborators). Credentials
 * are one group: the kinds of thing Kody uses on your behalf, plus the vaults
 * they can come from.
 */
function workspaceResourceGroups(
	orgSlug: string | null | undefined,
	personal: boolean,
): Array<AccountRailGroup> {
	return [
		{
			label: 'Build',
			items: [
				repositoriesRailItem(orgSlug),
				jobsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'webhooks'),
					id: 'webhooks',
					label: 'Webhooks',
					icon: 'cloud',
					description: 'Every inbound webhook your packages declare.',
				},
				{
					href: orgSectionHref(orgSlug, 'follows'),
					id: 'follows',
					label: 'Follows',
					icon: 'eye',
					description:
						'Packages and repositories this workspace gets new versions and pushes from.',
				},
			],
		},
		{
			label: 'Credentials',
			items: [
				credentialsRailItem(orgSlug),
				{
					href: orgSectionHref(orgSlug, 'secret-providers'),
					id: 'secret-providers',
					label: 'Secret providers',
					icon: 'lock',
					description: 'Bind a package to a provider such as 1password.',
				},
			],
		},
		{
			label: 'Agents & data',
			items: [
				agentsRailItem(orgSlug),
				...(personal ? [memoriesRailItem(orgSlug)] : []),
				{
					href: orgSectionHref(orgSlug, 'email'),
					id: 'email',
					label: 'Email',
					icon: 'mail',
					description:
						'This workspace inbox and the addresses Kody may send from.',
				},
			],
		},
		{ label: 'Activity', items: [activityRailItem(orgSlug)] },
	]
}

/**
 * The workspace rail: everything the organization owns, grouped by job.
 * Personal and team orgs share Build, Credentials, Agents & data (without
 * Memories on team orgs), and Activity above Organization. A team org's
 * Organization group holds Members (with Teams, Collaborators, and Grants as
 * tabs), Settings, Credits, and Usage and Billing for roles that manage it. A
 * personal org has no members or settings of its own (its name and photo are
 * the person's profile), so it lists Grants, Credits, and Usage and Billing.
 * Grant-only collaborators (`role` null) get Agents and their Credits budget,
 * with a note.
 */
export function workspaceRailGroups(input: {
	orgSlug: string | null | undefined
	/** True when `orgSlug` is the signup (personal) organization. */
	personal: boolean
	role: OrgRole | null
}): Array<AccountRailGroup> {
	const { orgSlug, personal, role } = input
	// Team chrome needs a slug. A missing signup slug still lists the
	// personal-shaped sections with `/account` fallbacks until one exists.
	if (!orgSlug && !personal) return []

	if (role === null) {
		if (!orgSlug) return []
		return [
			{
				label: 'Agents & data',
				items: [agentsRailItem(orgSlug)],
				note: 'Only Agents and Credits are available with a grant. Ask an owner for membership to open the rest of this workspace.',
			},
			{
				label: 'Organization',
				items: [
					{
						...creditsRailItem(orgSlug),
						description: 'Your monthly budget and what it has spent.',
					},
				],
			},
		]
	}

	const usage: AccountRailItem = {
		...usageRailItem(orgSlug),
		description: 'Activity, included compute, plan limits, and adding credits.',
	}
	const billing: AccountRailItem = {
		...billingRailItem(orgSlug),
		description: 'Plan, subscription, and payment method.',
	}
	const credits: Array<AccountRailItem> = orgSlug
		? [
				{
					...creditsRailItem(orgSlug),
					description: orgRoleManagesBilling(role)
						? 'Balance, budgets, and the full credit ledger.'
						: 'Your monthly budget and what it has spent.',
				},
			]
		: []
	const billingItems = orgRoleManagesBilling(role)
		? [usage, ...credits, billing]
		: credits
	const organizationItems: Array<AccountRailItem> =
		personal || !orgSlug
			? [grantsRailItem(orgSlug), ...billingItems]
			: [
					membersRailItem(orgSlug, role),
					{
						href: orgSettingsPath(orgSlug),
						id: 'settings',
						label: 'Settings',
						icon: 'edit',
						description: 'The organization name, photo, and deletion.',
					},
					...billingItems,
				]

	return [
		...(orgSlug
			? [{ label: null, items: [overviewRailItem(orgSlug, personal)] }]
			: []),
		...workspaceResourceGroups(orgSlug, personal),
		{ label: 'Organization', items: organizationItems },
	]
}

/** Tabs belong to a selected item identity, independent of URL shape. */
export function railTabsForSelection(
	groups: ReadonlyArray<AccountRailGroup>,
	itemId: string | undefined,
) {
	const item = groups
		.flatMap((group) => group.items)
		.find((entry) => entry.tabs && isAccountNavItemSelected(entry, itemId))
	if (!item?.tabs) return null
	return {
		label: item.label,
		tabs: item.tabs.map(({ id, ...tab }) => ({
			...tab,
			active: id === itemId,
		})),
	}
}
export function isAccountNavItemSelected(
	item: Pick<AccountRailItem, 'id' | 'tabs'>,
	itemId: string | undefined,
) {
	return (
		item.id === itemId || Boolean(item.tabs?.some((tab) => tab.id === itemId))
	)
}

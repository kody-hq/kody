import { expect, test } from 'vitest'
import {
	isAccountNavItemSelected,
	ownerWorkspaceHref,
	workspaceHomeHref,
	workspaceLandingItem,
	workspaceRailGroups,
	type AccountRailGroup,
} from './account-rail.ts'

const rails = {
	personal: workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		role: 'owner',
		profileUsername: 'jane',
	}),
	team: workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: 'owner',
		profileUsername: 'jane',
	}),
	billing: workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: 'billing',
	}),
	collaborator: workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: null,
	}),
} satisfies Record<string, Array<AccountRailGroup>>

function items(groups: Array<AccountRailGroup>) {
	return groups.flatMap((group) => group.items)
}

function selected(groups: Array<AccountRailGroup>, itemId: string) {
	return items(groups)
		.filter((item) => isAccountNavItemSelected(item, itemId))
		.map((item) => item.id)
}

test('Workspace opens the workspace Overview', () => {
	expect(workspaceLandingItem('jane').href).toBe('/@jane/-/overview')
	expect(workspaceLandingItem(null).href).toBe('/account')
})

test.each([
	['personal', rails.personal, '/@jane/-/overview', '/@jane'],
	['team', rails.team, '/@acme/-/overview', '/@acme'],
	['billing', rails.billing, '/@acme/-/overview', '/@acme'],
] as const)(
	'%s rail lists Public profile directly under Overview',
	(_kind, groups, overviewHref, profileHref) => {
		expect(
			groups[0]?.items.map(({ id, label, href }) => ({ id, label, href })),
		).toEqual([
			{ id: 'overview', label: 'Overview', href: overviewHref },
			{ id: 'public-profile', label: 'Public profile', href: profileHref },
		])
	},
)

test('a grant-only collaborator still gets Public profile for the org home', () => {
	expect(items(rails.collaborator).map((item) => item.id)).toEqual([
		'public-profile',
		'agents',
		'credits',
	])
	expect(items(rails.collaborator)[0]?.href).toBe('/@acme')
})

test('the personal Public profile follows a renamed username, team orgs never do', () => {
	const renamed = workspaceRailGroups({
		orgSlug: 'jane',
		personal: true,
		role: 'owner',
		profileUsername: 'jane-new',
	})
	expect(
		items(renamed).find((item) => item.id === 'public-profile')?.href,
	).toBe('/@jane-new')
	expect(
		items(rails.team).find((item) => item.id === 'public-profile')?.href,
	).toBe('/@acme')
})

test.each(Object.entries(rails))(
	'%s rail selects exactly one item per page and never by prefix',
	(_kind, groups) => {
		const ids = new Set(
			items(groups).flatMap((item) => [
				item.id,
				...(item.tabs ?? []).map((tab) => tab.id),
			]),
		)
		for (const id of ids) expect(selected(groups, id)).toHaveLength(1)
		expect(selected(groups, 'public-profile')).toEqual(
			ids.has('public-profile') ? ['public-profile'] : [],
		)
		expect(selected(groups, 'overview')).toEqual(
			ids.has('overview') ? ['overview'] : [],
		)
		// Pages without a rail item of their own select nothing.
		expect(selected(groups, 'packages')).toEqual([])
		expect(selected(groups, 'over')).toEqual([])
		const hrefs = items(groups).map((item) => item.href)
		expect(new Set(hrefs).size).toBe(hrefs.length)
	},
)

test('workspace home links open Overview for members, the org home for collaborators', () => {
	expect(
		workspaceHomeHref({ slug: 'jane', personal: true, role: 'owner' }),
	).toBe('/@jane/-/overview')
	expect(
		workspaceHomeHref({ slug: 'acme', personal: false, role: 'billing' }),
	).toBe('/@acme/-/overview')
	expect(workspaceHomeHref({ slug: 'acme', personal: false, role: null })).toBe(
		'/@acme',
	)
})

test('leaving an owner page opens that workspace Overview by org slug', () => {
	const organizations = [
		{ slug: 'jane', personal: true, role: 'owner' as const },
		{ slug: 'acme', personal: false, role: 'member' as const },
		{ slug: 'shared-co', personal: false, role: null },
	]
	expect(
		ownerWorkspaceHref({
			ownerHandle: 'acme',
			ownerIsPersonal: false,
			organizations,
		}),
	).toBe('/@acme/-/overview')
	// A renamed person's handle differs from the personal org slug.
	expect(
		ownerWorkspaceHref({
			ownerHandle: 'jane-new',
			ownerIsPersonal: true,
			organizations,
		}),
	).toBe('/@jane/-/overview')
	expect(
		ownerWorkspaceHref({
			ownerHandle: 'shared-co',
			ownerIsPersonal: false,
			organizations,
		}),
	).toBe('/@shared-co')
	expect(
		ownerWorkspaceHref({
			ownerHandle: 'acme-public',
			ownerIsPersonal: false,
			organizations,
		}),
	).toBe('/@acme-public')
})

test('Agent profiles sits right after Agents, marked as an experiment while the flag is off', () => {
	const agentsGroup = (groups: Array<AccountRailGroup>) =>
		groups.find((group) => group.items.some((item) => item.id === 'agents'))
			?.items ?? []
	const off = agentsGroup(rails.team)
	const offIds = off.map((item) => item.id)
	expect(offIds[offIds.indexOf('agents') + 1]).toBe('profiles')
	expect(off.find((item) => item.id === 'profiles')).toMatchObject({
		badge: 'Experiment',
		label: 'Agent profiles',
		href: '/@acme/-/profiles',
	})
	const on = agentsGroup(
		workspaceRailGroups({
			orgSlug: 'acme',
			personal: false,
			role: 'member',
			profiles: true,
		}),
	)
	expect(on.find((item) => item.id === 'profiles')?.badge).toBeUndefined()
})

test('Execution contexts sits right after Jobs in Build, marked as an experiment while the flag is off', () => {
	const build = (groups: Array<AccountRailGroup>) =>
		groups
			.find((group) => group.label === 'Build')
			?.items.map((item) => item.id)
	const offIds = build(rails.team) ?? []
	expect(offIds[offIds.indexOf('jobs') + 1]).toBe('execution-contexts')
	expect(
		items(rails.team).find((item) => item.id === 'execution-contexts'),
	).toMatchObject({ badge: 'Experiment' })
	const flagged = workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: 'member',
		executionContexts: true,
	})
	const ids = build(flagged) ?? []
	expect(ids[ids.indexOf('jobs') + 1]).toBe('execution-contexts')
	expect(
		items(flagged).find((item) => item.id === 'execution-contexts'),
	).toMatchObject({
		href: '/@acme/-/execution-contexts',
		icon: 'server',
	})
	expect(
		items(flagged).find((item) => item.id === 'execution-contexts')?.badge,
	).toBeUndefined()
	const collaborator = workspaceRailGroups({
		orgSlug: 'acme',
		personal: false,
		role: null,
		executionContexts: true,
	})
	expect(items(collaborator).map((item) => item.id)).not.toContain(
		'execution-contexts',
	)
})

import { expect, test } from 'vitest'
import {
	accountAliasPath,
	orgResourcePathForAccountPath,
	orgCreditsPath,
	orgUsagePath,
	orgUsageWhereItWentPath,
	relocateAccountHref,
	orderOrganizations,
	orgIdentity,
	orgOwnedSectionForPath,
	orgOverviewPath,
	orgSlugFromOrgOwnedPath,
	organizationsWithSignupFallback,
	orgSwitcherEntries,
	parseOrgBillingPath,
	parseOrgManagementPath,
	parseOrgOverviewPath,
	parseOrgResourcePath,
	parseOrgCreditsPath,
	parseOrgUsagePath,
	type OrganizationSummary,
	urlOrgSlug,
} from './org-pages.ts'

const personal: OrganizationSummary = {
	slug: 'ada',
	displayName: 'Ada',
	role: 'owner',
	personal: true,
}
const acme: OrganizationSummary = {
	slug: 'acme',
	displayName: 'Acme',
	role: 'member',
	personal: false,
}
const billing: OrganizationSummary = {
	slug: 'billing-co',
	displayName: null,
	role: 'billing',
	personal: false,
}

test('account-shaped section paths become canonical org links', () => {
	expect(orgResourcePathForAccountPath('/account/packages', 'ada')).toBe(
		'/@ada/-/repositories',
	)
	expect(orgResourcePathForAccountPath('/account/secrets', 'ada')).toBe(
		'/@ada/-/secrets',
	)
	expect(orgResourcePathForAccountPath('/account/secrets/new', 'ada')).toBe(
		'/@ada/-/secrets/new',
	)
	expect(orgResourcePathForAccountPath('/account/jobs/job-1', 'ada')).toBe(
		'/@ada/-/jobs/job-1',
	)
	expect(orgResourcePathForAccountPath('/account/billing', 'ada')).toBe(
		'/@ada/-/billing',
	)
	expect(orgResourcePathForAccountPath('/account/billing/success', 'ada')).toBe(
		'/@ada/-/billing/success',
	)
	expect(orgResourcePathForAccountPath('/account/usage', 'ada')).toBe(
		'/@ada/-/usage',
	)
	expect(orgResourcePathForAccountPath('/account/credits', 'ada')).toBe(
		'/@ada/-/usage',
	)
	expect(orgResourcePathForAccountPath('/account/packages/pkg-1', 'ada')).toBe(
		null,
	)
	expect(orgResourcePathForAccountPath('/account/secrets.json', 'ada')).toBe(
		null,
	)
	expect(orgResourcePathForAccountPath('/account/passkeys', 'ada')).toBe(null)
	expect(orgResourcePathForAccountPath('/account', 'ada')).toBe(null)
	expect(orgResourcePathForAccountPath('/account/experiments', 'ada')).toBe(
		null,
	)
	expect(
		relocateAccountHref('/account/secrets/new?q=1', '/@ada/-/secrets'),
	).toBe('/@ada/-/secrets/new?q=1')
	expect(relocateAccountHref('/account/passkeys', '/@ada/-/secrets')).toBe(
		'/account/passkeys',
	)
})

test('org resource paths alias back to account loaders and ignore package apps', () => {
	expect(parseOrgResourcePath('/@acme/-/secrets/user/token')).toEqual({
		slug: 'acme',
		section: 'secrets',
		rest: 'user/token',
	})
	expect(accountAliasPath('/@acme/-/secrets/user/token')).toBe(
		'/account/secrets/user/token',
	)
	expect(parseOrgResourcePath('/@acme/packages/devin')).toBeNull()
	expect(parseOrgResourcePath('/@acme/webhooks/devin/hook/secret')).toBeNull()
	// Two-segment paths are package pages, not org sections.
	expect(parseOrgResourcePath('/@acme/secrets')).toBeNull()
	expect(parseOrgResourcePath('/@acme/billing')).toBeNull()
	expect(parseOrgBillingPath('/@acme/billing')).toBeNull()
	expect(parseOrgResourcePath('/@acme/-/repositories')).toEqual({
		slug: 'acme',
		section: 'repositories',
		rest: '',
	})
	expect(parseOrgResourcePath('/@acme/-/packages')).toBeNull()
})

test('the workspace overview is an org-owned page under the /- separator', () => {
	expect(orgOverviewPath('ada')).toBe('/@ada/-/overview')
	expect(parseOrgOverviewPath('/@ada/-/overview')).toEqual({ slug: 'ada' })
	expect(parseOrgOverviewPath('/@ada/-/overview/')).toEqual({ slug: 'ada' })
	expect(parseOrgOverviewPath('/@ada/-/overview/extra')).toBeNull()
	expect(parseOrgOverviewPath('/@ada/overview')).toBeNull()
	expect(orgSlugFromOrgOwnedPath('/@ada/-/overview')).toBe('ada')
})

test('management paths name settings and members under the /- separator', () => {
	expect(parseOrgManagementPath('/@acme/-/settings')).toEqual({
		slug: 'acme',
		section: 'settings',
	})
	expect(parseOrgManagementPath('/@acme/-/teams')).toEqual({
		slug: 'acme',
		section: 'teams',
	})
	expect(parseOrgManagementPath('/@acme/-/collaborators')).toEqual({
		slug: 'acme',
		section: 'collaborators',
	})
	expect(parseOrgManagementPath('/@acme/settings')).toBeNull()
	expect(parseOrgManagementPath('/@acme/secrets')).toBeNull()
	expect(parseOrgResourcePath('/@acme/settings')).toBeNull()
})

test('switcher lists the signup organization first, then roles, then create and any waiting invites', () => {
	expect(
		orderOrganizations([acme, billing, personal]).map((org) => org.slug),
	).toEqual(['ada', 'acme', 'billing-co'])

	const multiple = orgSwitcherEntries([acme, personal], 2)
	expect(multiple).toEqual([
		{ kind: 'org', org: personal, showRole: true },
		{ kind: 'org', org: acme, showRole: true },
		{ kind: 'create' },
		{ kind: 'invites', count: 2 },
	])

	const single = orgSwitcherEntries([personal], 0)
	expect(single.map((entry) => entry.kind)).toEqual(['org', 'create'])
	expect(single[0]).toEqual({ kind: 'org', org: personal, showRole: false })
})

test('current organization comes only from the URL', () => {
	const organizations = [personal, acme]
	expect(urlOrgSlug({ pathname: '/@acme/-/secrets', organizations })).toBe(
		'acme',
	)
	expect(urlOrgSlug({ pathname: '/@acme', organizations })).toBe('acme')
	// Pages without an org in the URL have no current org.
	expect(urlOrgSlug({ pathname: '/account', organizations })).toBeNull()
	expect(
		urlOrgSlug({ pathname: '/account/organizations', organizations }),
	).toBeNull()
})

test('org-owned URL slug wins even when the session list is empty or personal-only', () => {
	expect(
		urlOrgSlug({ pathname: '/@acme/-/settings', organizations: [personal] }),
	).toBe('acme')
	expect(urlOrgSlug({ pathname: '/@acme/-/members', organizations: [] })).toBe(
		'acme',
	)
	// Public profile and package pages still require membership.
	expect(
		urlOrgSlug({ pathname: '/@acme', organizations: [personal] }),
	).toBeNull()
	expect(
		urlOrgSlug({ pathname: '/@acme/some-pkg', organizations: [personal] }),
	).toBeNull()
})

test('org rows show the signup organization as the person and others by name or handle', () => {
	const viewer = { displayName: 'Ada Lovelace', avatarUrl: '/avatars/ada.png' }
	expect(orgIdentity({ ...personal, displayName: null }, viewer)).toEqual({
		name: 'Ada Lovelace',
		handle: '@ada',
		hasName: true,
		avatarName: 'Ada Lovelace',
		avatarUrl: '/avatars/ada.png',
	})
	expect(orgIdentity(personal, viewer).name).toBe('Ada Lovelace')
	expect(
		orgIdentity(personal, { displayName: ' ', avatarUrl: null }).name,
	).toBe('Ada')
	expect(orgIdentity(acme, viewer)).toEqual({
		name: 'Acme',
		handle: '@acme',
		hasName: true,
		avatarName: 'Acme',
		avatarUrl: null,
	})
	expect(
		orgIdentity({ ...acme, avatarUrl: '/orgs/acme/avatar/hash.png' }, viewer)
			.avatarUrl,
	).toBe('/orgs/acme/avatar/hash.png')
	expect(orgIdentity({ ...billing, displayName: '  ' }, viewer)).toEqual({
		name: '@billing-co',
		handle: '@billing-co',
		hasName: false,
		avatarName: 'billing-co',
		avatarUrl: null,
	})
})

test('a session without memberships still lists the signup organization', () => {
	expect(
		organizationsWithSignupFallback({ organizations: [acme], username: 'ada' }),
	).toEqual([acme])
	expect(
		organizationsWithSignupFallback({ organizations: [], username: 'ada' }),
	).toEqual([{ slug: 'ada', displayName: null, role: 'owner', personal: true }])
	expect(
		organizationsWithSignupFallback({ organizations: [], username: '' }),
	).toEqual([])
})

test('billing paths bind to the organization in the URL', () => {
	for (const pathname of [
		'/@acme/-/billing',
		'/@acme/-/billing/',
		'/@acme/-/billing/success',
	]) {
		expect(parseOrgBillingPath(pathname)).toEqual({ slug: 'acme' })
	}
	expect(parseOrgBillingPath('/account/billing')).toBeNull()
	expect(parseOrgBillingPath('/@acme/-/billing/portal/extra')).toBeNull()
	expect(parseOrgBillingPath('/@acme/billings')).toBeNull()
	expect(parseOrgBillingPath('/@Not A Slug/billing')).toBeNull()
})

test('usage paths bind to the organization in the URL', () => {
	expect(orgUsagePath('acme')).toBe('/@acme/-/usage')
	for (const pathname of ['/@acme/-/usage', '/@acme/-/usage/']) {
		expect(parseOrgUsagePath(pathname)).toEqual({ slug: 'acme' })
	}
	expect(parseOrgUsagePath('/account/usage')).toBeNull()
	expect(parseOrgUsagePath('/@acme/-/usage/extra')).toBeNull()
	expect(parseOrgUsagePath('/@acme/usage')).toBeNull()
	expect(parseOrgUsagePath('/@Not A Slug/usage')).toBeNull()
	expect(orgSlugFromOrgOwnedPath('/@acme/-/usage')).toBe('acme')
	expect(orgSlugFromOrgOwnedPath('/@acme/-/usage.json')).toBeNull()
})

test('credits paths bind to the organization in the URL', () => {
	expect(orgCreditsPath('acme')).toBe('/@acme/-/credits')
	expect(orgUsageWhereItWentPath('acme')).toBe('/@acme/-/usage#where-it-went')
	for (const pathname of ['/@acme/-/credits', '/@acme/-/credits/']) {
		expect(parseOrgCreditsPath(pathname)).toEqual({ slug: 'acme' })
		expect(orgSlugFromOrgOwnedPath(pathname)).toBe('acme')
	}
	expect(parseOrgCreditsPath('/@acme/-/credits/extra')).toBeNull()
	expect(parseOrgCreditsPath('/@acme/credits')).toBeNull()
	expect(parseOrgCreditsPath('/@Not A Slug/-/credits')).toBeNull()
})

test('every org-bound URL names its section, or none for billing and management', () => {
	expect(orgOwnedSectionForPath('/@acme/-/memories/m-1')).toBe('memories')
	expect(orgOwnedSectionForPath('/@acme/-/repositories')).toBe('repositories')
	expect(orgOwnedSectionForPath('/account/workflows.json')).toBeNull()
	expect(orgOwnedSectionForPath('/account/memories-export.json')).toBe(
		'memories',
	)
	expect(orgOwnedSectionForPath('/@acme/-/settings.json')).toBeNull()
	expect(orgOwnedSectionForPath('/@acme/-/billing')).toBeNull()
	expect(orgOwnedSectionForPath('/@acme/-/nope.json')).toBeNull()
	expect(orgSlugFromOrgOwnedPath('/@acme/-/repositories.json')).toBeNull()
	expect(orgSlugFromOrgOwnedPath('/@acme/packages.json')).toBeNull()
})

test.each([
	'/@acme/-/repositories.json',
	'/@acme/-/follows.json',
	'/@acme/-/billing.json',
	'/@acme/-/billing/checkout.json',
	'/@acme/-/billing/portal',
	'/@acme/-/usage.json',
	'/@acme/-/approvals/bundle-id.json',
	'/@acme/-/settings.json',
	'/@acme/-/settings/avatar.json',
	'/@acme/-/members/invite.json',
	'/@acme/-/members/invite-links.json',
	'/@acme/-/members/invite-links-revoke.json',
	'/@acme/-/grants/revoke.json',
	'/@acme/-/collaborators.json',
])(
	'obsolete website endpoint does not establish org page scope: %s',
	(pathname) => {
		expect(orgSlugFromOrgOwnedPath(pathname)).toBeNull()
		expect(orgOwnedSectionForPath(pathname)).toBeNull()
	},
)

test('retired billing portal action is not rewritten as an organization page', () => {
	expect(
		orgResourcePathForAccountPath('/account/billing/portal', 'ada'),
	).toBeNull()
})

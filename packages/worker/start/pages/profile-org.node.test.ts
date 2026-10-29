import { createElement } from 'react'
import { expect, test } from 'vitest'
import { type ProfileLoaderData } from '#universal/loader-data.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { OrgHomePage } from './org-home.tsx'
import { ProfileRoute } from './profile.tsx'

const orgPage = {
	ok: true,
	ownerKind: 'org',
	profile: {
		username: 'acme-team',
		displayName: 'Acme Team',
		bio: 'We build helpers.',
		avatarUrl: null,
		visibility: 'public',
		joinedAt: '2026-02-01T00:00:00.000Z',
		publicPackageCount: 1,
		listingCount: 0,
	},
	packages: [
		{
			name: '@acme-team/open-helper',
			kodyId: 'open-helper',
			description: 'Helpful package',
			tags: [],
			updatedAt: '2026-07-01T00:00:00.000Z',
			createdAt: '2026-06-01T00:00:00.000Z',
			communityListingId: null,
			communityListingKodyId: null,
			communityPublishedAt: null,
			needsRepublish: false,
			hasPackage: true,
			hasApp: false,
			webhookCount: 0,
			jobCount: 0,
			isInternetVisible: false,
			iconUrl: null,
			href: '/@acme-team/open-helper',
		},
	],
	activity: null,
	query: null,
	isSelf: false,
	loggedIn: false,
} as unknown as ProfileLoaderData

function text(html: string) {
	return html.replaceAll('<!-- -->', '')
}

test('a public team org page renders identity and public packages, with the home link only for members', async () => {
	const visitor = text(
		await renderStartPage(
			createElement(ProfileRoute, {
				data: orgPage,
				currentHref: '/@acme-team',
			}),
			'/@acme-team',
		),
	)
	expect(visitor).toContain('Acme Team')
	expect(visitor).toContain('We build helpers.')
	expect(visitor).toContain('data-testid="profile-org-badge"')
	expect(visitor).toContain('open-helper')
	expect(visitor).toContain('Created')
	expect(visitor).not.toContain('data-testid="profile-org-home"')
	expect(visitor).not.toMatch(/Members|Billing/)

	const member = text(
		await renderStartPage(
			createElement(ProfileRoute, {
				data: { ...orgPage, loggedIn: true },
				currentHref: '/@acme-team',
				orgHomeHref: '/@acme-team?view=home',
			}),
			'/@acme-team',
		),
	)
	expect(member).toContain('href="/@acme-team?view=home"')
	expect(member).toContain('Organization home')
})

test('the org home links back to the public page only while the org is public', async () => {
	const org = {
		slug: 'acme-team',
		displayName: 'Acme Team',
		role: 'member' as const,
	}
	const open = await renderStartPage(
		createElement(OrgHomePage, { org, publicPageHref: '/@acme-team' }),
		'/@acme-team?view=home',
	)
	expect(open).toContain('data-testid="org-public-page"')
	const closed = await renderStartPage(
		createElement(OrgHomePage, { org, publicPageHref: null }),
		'/@acme-team',
	)
	expect(closed).not.toContain('data-testid="org-public-page"')
})

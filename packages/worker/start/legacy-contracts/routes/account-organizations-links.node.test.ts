import { jsx } from 'react/jsx-runtime'
import { renderStartPage } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { OrganizationsPage } from '../../pages/org-organizations.tsx'
import type { SessionInfo } from '../../../client/session.ts'
import type { AccountOrganizationsLoaderData } from '#universal/loader-data.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

const data: AccountOrganizationsLoaderData = {
	ok: true,
	username: 'jane',
	viewer: { displayName: 'Jane', avatarUrl: null },
	organizations: [
		{
			slug: 'jane',
			displayName: 'Jane',
			role: 'owner',
			personal: true,
			avatarUrl: null,
		},
		{
			slug: 'acme',
			displayName: 'Acme',
			role: 'member',
			personal: false,
			avatarUrl: null,
		},
		{
			slug: 'shared-co',
			displayName: 'Shared Co',
			role: null,
			personal: false,
			avatarUrl: null,
		},
	],
	restorableOrganizations: [],
	pendingInvites: [],
}

function cardHrefs(html: string) {
	return html
		.split('data-testid="account-organization"')
		.slice(1)
		.map((row) => row.match(/<a[^>]*href="([^"]+)"/)?.[1])
}

test('organization cards open each workspace Overview', async () => {
	const html = await renderStartPage(
		jsx(OrganizationsPage, { data }),
		'/account/organizations',
		session,
	)
	expect(cardHrefs(html).sort()).toEqual(
		[
			'/@jane/-/overview',
			'/@acme/-/overview',
			// Grant-only collaborators have no Overview; they open the org home.
			'/@shared-co',
		].sort(),
	)
})

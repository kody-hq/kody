import { createElement } from 'react'
import { expect, test } from 'vitest'
import { type ProfilesPageData } from '#universal/profiles.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { profilesPageFixture } from '../test-support/profiles-fixtures.ts'
import { ProfilesRoute } from './profiles.tsx'

const href = '/@jane/-/profiles'

function route(payload: ProfilesPageData) {
	return createElement(ProfilesRoute, { payload, currentHref: href })
}

function text(html: string) {
	return html
		.replace(/<!-- -->/g, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
}

test('flag off shows the opt-in callout, not a permission error', async () => {
	const html = await renderStartPage(
		route({ enabled: false, orgSlug: 'jane' }),
		href,
	)
	expect(html).toContain('data-testid="profiles-flag-off"')
	expect(html).toContain('href="/account/experiments"')
	expect(text(html)).toContain('Try agent profiles')
	expect(text(html)).not.toMatch(/permission|denied/i)
	expect(html).not.toContain('role="tree"')
})

test('flag on renders the hierarchy as an accessible tree', async () => {
	const html = await renderStartPage(route(profilesPageFixture()), href)
	const body = text(html)
	expect(html).toContain('role="tree"')
	expect(html).toMatch(/role="treeitem"[^>]*aria-level="2"/)
	expect(html).toContain('role="group"')
	expect(html).toContain('data-profile-status="parent_inactive"')
	expect(html).toContain('data-parent-inactive=""')
	expect(body).toContain('release-bot')
	expect(body).toContain('changelog-writer')
	expect(body).toContain('Parent inactive')
	expect(body).toContain('Effective expiry (with parents)')
	expect(body).toContain('deploy-tools')
	expect(body).toContain('package:execute')
	expect(body).toContain('release-bot ci')
	expect(body).toContain('Add sub-profile')
	expect(body).toContain('profile_expiry_extension')
	expect(body).toContain('npx @kodycodes/cli')
	expect(body).toContain('tokenCreate')
})

test('empty state invites the first profile', async () => {
	const html = await renderStartPage(
		route(profilesPageFixture({ profiles: [], tokens: [] })),
		href,
	)
	expect(html).toContain('data-testid="profiles-empty"')
	expect(text(html)).toContain('Create your first profile')
	expect(html).not.toContain('role="tree"')
})

test('Owners viewing every member can revoke but not edit', async () => {
	const payload = profilesPageFixture({
		personalOrg: false,
		allMembers: true,
		viewer: { userId: 'u_owner', username: 'owner', isOwner: true },
	})
	const html = await renderStartPage(route(payload), href)
	const body = text(html)
	expect(body).toContain('Every member (Owner)')
	expect(body).toContain('Revoke')
	expect(body).toContain('Owners can revoke this profile but not edit it.')
	expect(body).not.toContain('Add sub-profile')
	expect(body).not.toContain('Shorten expiry')
})

test('a refused list shows its message', async () => {
	const html = await renderStartPage(
		route(
			profilesPageFixture({
				profiles: [],
				listError: 'You need profile:manage in this org.',
			}),
		),
		href,
	)
	expect(text(html)).toContain('You need profile:manage in this org.')
	expect(html).not.toContain('data-testid="profiles-empty"')
})

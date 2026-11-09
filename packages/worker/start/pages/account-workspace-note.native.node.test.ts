import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import type { SessionInfo } from '#client/session.ts'
import { routeTree } from '../routeTree.gen.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { AccountPage } from './account.tsx'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
	organizations: [
		{ slug: 'jane', displayName: 'Jane', role: 'owner', personal: true },
		{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
	],
}

function renderAccountSettings() {
	return renderStartPage(
		jsx(AccountPage, {
			view: 'profile',
			currentHref: '/account',
			payloads: {
				accountProfile: {
					ok: true,
					email: 'jane@example.com',
					emailVerified: true,
					username: 'jane',
					displayName: 'Jane',
					bio: null,
					avatarUrl: null,
					profileVisibility: 'public',
					formerEmails: [],
				},
				accountConnections: {
					ok: true,
					connections: [],
					canDisconnect: false,
					hasUsablePassword: true,
					availableProviders: [],
					canSyncDiscordRoles: false,
				},
				onboarding: null,
			},
		}),
		'/account',
		session,
	)
}

function hrefsIn(html: string, marker: string) {
	const start = html.indexOf(marker)
	expect(start).toBeGreaterThan(-1)
	const end = html.indexOf('</aside>', start)
	return [...html.slice(start, end).matchAll(/href="([^"]+)"/g)].map(
		(match) => match[1],
	)
}

test('account settings point to the signup workspace overview and team workspaces', async () => {
	const html = await renderAccountSettings()
	const hrefs = hrefsIn(html, 'data-testid="account-workspace-note"')
	expect(hrefs).toEqual(['/@jane/-/overview', '/account/organizations'])

	const router = createRouter({
		routeTree,
		history: createMemoryHistory(),
		context: { queryClient: new QueryClient(), getCommittedPage: () => null },
	})
	const [, , overview] = router.getMatchedRoutes('/@jane/-/overview')
	expect(overview?.fullPath).toBe('/@{$orgSlug}/-/overview')
})

test('the account rail stays person-only next to the workspace note', async () => {
	const html = await renderAccountSettings()
	const start = html.indexOf('aria-label="Account sections"')
	expect(start).toBeGreaterThan(-1)
	const rail = html.slice(start, html.indexOf('</nav>', start))
	expect(rail).toContain('href="/account/organizations"')
	expect(rail).not.toMatch(/href="\/@/)
})

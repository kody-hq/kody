import { createElement } from 'react'
import { expect, test } from 'vitest'
import { type SessionInfo } from '#client/session.ts'
import { AccountManagementShell } from './pages/account-management-components.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

const session: SessionInfo = {
	email: 'ada@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'ada',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
	organizations: [
		{ slug: 'ada', displayName: 'Ada', role: 'owner', personal: true },
		{ slug: 'acme', displayName: 'Acme', role: 'owner', personal: false },
	],
}

test('account rail contains personal settings without a workspace list or switcher', async () => {
	const href = '/account/security'
	const html = await renderStartPage(
		createElement(AccountManagementShell, {
			currentHref: href,
			children: 'Security',
		}),
		href,
		session,
	)
	expect(html).toContain('aria-label="Account sections"')
	expect(html).toContain('href="/account/security"')
	expect(html).not.toContain('switch organization')
	expect(html).not.toContain('aria-label="Workspaces"')
	expect(html).not.toContain('href="/@acme"')
	expect(html).not.toContain('href="/@ada/-/overview"')
})

test('workspace rail retains its organization switcher on desktop and in the drawer', async () => {
	const href = '/@acme/-/credentials'
	const html = await renderStartPage(
		createElement(AccountManagementShell, {
			currentHref: href,
			children: 'Credentials',
		}),
		href,
		session,
	)
	expect(html).toContain('aria-label="Workspace sections"')
	expect(html).toContain('data-testid="org-switcher"')
	expect(html).toContain('data-testid="org-switcher-drawer"')
	expect(html).toContain('aria-label="@acme: switch organization"')
	expect(html).toContain('href="/@ada/-/credentials"')
})

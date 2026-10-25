import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { AccountConnectedAppsPage } from './account-connected-apps.tsx'
import { type AccountConnectedAppsLoaderData } from '#universal/loader-data.ts'

const payload: AccountConnectedAppsLoaderData = {
	ok: true,
	apps: [
		{
			appKey: 'acme/calendar',
			appName: 'Calendar',
			publisherName: 'Acme',
			iconUrl: null,
			allows: [
				'See your name, username, and avatar',
				'See your access level for this app',
				'See your email address',
				'Read your calendar to find an open time.',
			],
			revocableScopes: [
				{ scope: 'profile', label: 'See your name, username, and avatar' },
				{ scope: 'email', label: 'See your email address' },
				{
					scope: 'need:calendar',
					label: 'Read your calendar to find an open time.',
				},
				{ scope: 'unknown', label: 'Unknown access' },
			],
			connectedAt: '2026-10-16T00:00:00.000Z',
			lastUsedAt: null,
		},
	],
	agents: [],
	agentsUnavailable: false,
}

test('connected apps only render styled revoke controls for optional scopes', async () => {
	const html = await renderStartPage(
		createElement(AccountConnectedAppsPage, {
			payload,
			currentHref: '/account/connected-apps',
		}),
		'/account/connected-apps',
	)
	expect(html).toContain('See your access level for this app')
	const emailLabelIndex = html.indexOf('See your email address')
	const emailListItemEnd = html.indexOf('</li>', emailLabelIndex)
	const emailRevokeIndex = html.indexOf(
		'aria-label="Revoke See your email address"',
	)
	expect(emailRevokeIndex).toBeGreaterThan(emailLabelIndex)
	expect(emailRevokeIndex).toBeLessThan(emailListItemEnd)
	expect(html).toContain('aria-label="Revoke See your email address"')
	expect(html).toContain(
		'aria-label="Revoke Read your calendar to find an open time."',
	)
	expect(html).not.toContain('aria-label="Revoke See your name')
	expect(html).not.toContain('aria-label="Revoke Unknown access"')
	expect(html.match(/>Revoke<\/button>/g)).toHaveLength(2)
	const profileLabelIndex = html.indexOf('See your name, username, and avatar')
	const profileListItemEnd = html.indexOf('</li>', profileLabelIndex)
	expect(
		html.indexOf('aria-label="Revoke See your name, username, and avatar"'),
	).toBe(-1)
	expect(html.slice(profileLabelIndex, profileListItemEnd)).not.toContain(
		'aria-label="Revoke',
	)
})

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
				{
					label: 'See your name, username, and avatar',
					scope: null,
				},
				{
					label: 'See your access level for this app',
					scope: null,
				},
				{ label: 'See your email address', scope: 'email' },
				{
					label: 'Read your calendar to find an open time.',
					scope: 'need:calendar',
					disconnectableCredentials: [
						{ id: 'credential-calendar', name: 'Calendar' },
					],
				},
				{
					label: 'Read your calendar to find an open time.',
					scope: 'need:events',
				},
				{ label: 'Unknown access', scope: null },
			],
			connectedAt: '2026-10-16T00:00:00.000Z',
			lastUsedAt: null,
			disconnectableCredentials: [
				{ id: 'credential-calendar', name: 'Calendar' },
			],
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
	expect(
		html.match(
			/aria-label="Revoke Read your calendar to find an open time\."/g,
		),
	).toHaveLength(2)
	expect(html).not.toContain('aria-label="Revoke See your name')
	expect(html).not.toContain('aria-label="Revoke Unknown access"')
	expect(html.match(/>Revoke<\/button>/g)).toHaveLength(3)
	const profileLabelIndex = html.indexOf('See your name, username, and avatar')
	const profileListItemEnd = html.indexOf('</li>', profileLabelIndex)
	expect(
		html.indexOf('aria-label="Revoke See your name, username, and avatar"'),
	).toBe(-1)
	expect(html.slice(profileLabelIndex, profileListItemEnd)).not.toContain(
		'aria-label="Revoke',
	)
})

test('connected apps hide disconnect options when there are no unused credentials', async () => {
	const noDisconnectOptions: AccountConnectedAppsLoaderData = {
		...payload,
		apps: payload.apps.map((app) => ({
			...app,
			disconnectableCredentials: [],
			allows: app.allows.map((allow) => ({
				...allow,
				disconnectableCredentials: [],
			})),
		})),
	}
	const html = await renderStartPage(
		createElement(AccountConnectedAppsPage, {
			payload: noDisconnectOptions,
			currentHref: '/account/connected-apps',
		}),
		'/account/connected-apps',
	)
	expect(html).not.toContain('Also disconnect')
})

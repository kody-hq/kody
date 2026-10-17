import { createElement } from 'react'
import { expect, test } from 'vitest'
import { AccountPage } from './pages/account.tsx'
import { AccountConnectionsPage } from './pages/account-connections.tsx'
import { AccountMemoriesPage } from './pages/account-memories.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

// Render with a deliberately different link location. Selection belongs to the
// retained route's decoded params, not a second parser in the page component.
test('memories uses the provided detail identity instead of reparsing link location', async () => {
	const html = await renderStartPage(
		createElement(AccountMemoriesPage, {
			currentHref: '/@team/-/memories?q=needle',
			selectedId: 'missing.id',
			payload: {
				ok: true,
				email: 'owner@example.com',
				username: 'owner',
				memories: [],
				selectedMemory: null,
				query: 'needle',
				includeDeleted: false,
				legacyReadOnly: false,
			},
		}),
		'/@team/-/memories?q=needle',
	)
	expect(html).toContain('Memory not found')
	expect(html).toContain('value="needle"')
})

test('account renders the native data view even with a retained profile location', async () => {
	const html = await renderStartPage(
		createElement(AccountPage, {
			view: 'data',
			currentHref: '/account',
			payloads: {
				accountProfile: {
					ok: true,
					email: 'owner@example.com',
					emailVerified: true,
					username: 'owner',
					displayName: 'Owner',
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
	)
	expect(html).toContain('Data &amp; deletion')
})
test('agents renders the native unknown-agent view instead of selecting a list from href', async () => {
	const html = await renderStartPage(
		createElement(AccountConnectionsPage, {
			view: null,
			currentHref: '/@team/-/agents',
			orgSlug: 'team',
			payload: { ok: true, agents: [], mcpServerUrl: 'https://kody.test/mcp' },
		}),
		'/@team/-/agents',
	)
	expect(html).toContain('Unknown agent')
	expect(html).toContain('/@team/-/agents/new')
})

import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { useAccountConnectedAgents } from './pages/account-connected-agents-panel.tsx'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'
function makeAgent(
	clientId: string,
	label: string,
	kind: AccountConnectedAgentListItem['kind'],
	connectedAt: string,
	lastUsedAt: string | null = null,
): AccountConnectedAgentListItem {
	return {
		clientId,
		grantIds: [`grant-${clientId}`],
		connectionProfileName: null,
		label,
		kind,
		connectedAt,
		lastUsedAt,
	}
}

const cursorOld = makeAgent(
	'cursor-old',
	'Cursor',
	'cursor',
	'2024-01-01T00:00:00.000Z',
	'2024-08-01T00:00:00.000Z',
)
const cursorNew = makeAgent(
	'cursor-new',
	'Cursor',
	'cursor',
	'2024-06-01T00:00:00.000Z',
	'2024-05-01T00:00:00.000Z',
)
const chatgptOld = makeAgent(
	'https://chatgpt.com/oauth/vG3/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-03-01T00:00:00.000Z',
)
const chatgptNew = makeAgent(
	'https://chatgpt.com/oauth/vG4/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-04-01T00:00:00.000Z',
)
const acme = makeAgent(
	'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
	'Acme Agent',
	null,
	'2024-05-01T00:00:00.000Z',
)
const allAgents = [cursorOld, cursorNew, chatgptOld, chatgptNew, acme]

const listedAgents: AccountConnectedAgentsLoaderData = {
	ok: true,
	mcpServerUrl: 'https://kody.example/mcp',
	agents: allAgents,
}

function groupBlock(html: string, label: string, nextLabel?: string) {
	const start = html.indexOf(`data-agent-label="${label}"`)
	return nextLabel
		? html.slice(start, html.indexOf(`data-agent-label="${nextLabel}"`))
		: html.slice(start)
}

function Panel() {
	return useAccountConnectedAgents(listedAgents).render()
}
test('connected agents panel groups same-name hosts, shows logos, and keeps revoke inside details', async () => {
	const html = (
		await renderStartPage(jsx(Panel, {}), '/account/agents')
	).replaceAll('<!-- -->', '')
	expect(html).toContain('data-testid="connected-agent-group"')
	expect(html).toContain('/images/icons/cursor.svg')
	expect(html).toContain('/images/icons/chatgpt.svg')
	expect(html).toContain('data-testid="connected-agent-mark-fallback"')
	expect(html).toContain('2 connections')

	const groupOrder = [...html.matchAll(/data-agent-label="([^"]+)"/g)].map(
		(match) => match[1],
	)
	expect(groupOrder).toEqual(['Cursor', 'Acme Agent', 'ChatGPT.com'])

	const cursorBlock = groupBlock(html, 'Cursor', 'Acme Agent')
	expect(cursorBlock).toContain('data-testid="connected-agent-view-steps"')
	expect(cursorBlock).toContain('data-agent-kind="cursor"')
	expect(cursorBlock).toContain('href="/account/agents/new/cursor"')
	expect(cursorBlock).toContain('<details')
	expect(cursorBlock).toContain('<summary')
	expect(cursorBlock.indexOf('cursor-old')).toBeLessThan(
		cursorBlock.indexOf('cursor-new'),
	)
	expect(cursorBlock).toContain('Last used')
	expect(html).toMatch(/Last used <span[^>]*>unknown<\/span>/)
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-n…)"')
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-o…)"')

	const chatgptBlock = groupBlock(html, 'ChatGPT.com')
	expect(chatgptBlock).toContain('data-testid="connected-agent-view-steps"')
	expect(chatgptBlock).toContain('data-agent-kind="chatgpt"')
	expect(chatgptBlock).toContain('href="/account/agents/new/chatgpt"')
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG4)"',
	)
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG3)"',
	)
	expect(chatgptBlock.indexOf('vG4')).toBeLessThan(chatgptBlock.indexOf('vG3'))

	expect(groupBlock(html, 'Acme Agent', 'ChatGPT.com')).not.toContain(
		'data-testid="connected-agent-view-steps"',
	)
	expect(html).toContain('aria-label="Revoke Acme Agent"')

	// Confirm stays in the Revoke slot: both labels are grid-stacked, and the
	// row is a two-column grid so the longer confirm copy cannot wrap under.
	expect(html).toContain('data-swap-label')
	expect(html).toContain('>Confirm revoke</span>')
	expect(html).toContain('grid-template-columns:minmax(0, 1fr) auto')
})

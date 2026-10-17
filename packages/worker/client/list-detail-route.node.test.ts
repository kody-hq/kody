import { expect, test } from 'vitest'
import { createListDetailLinks } from './list-detail-route.ts'

const mcpServersRoute = createListDetailLinks('/account/mcp-servers')

test('resource links preserve search and encoded identities', () => {
	expect(mcpServersRoute.buildListHref()).toBe('/account/mcp-servers')
	expect(mcpServersRoute.buildListHref('?q=docs')).toBe(
		'/account/mcp-servers?q=docs',
	)
	expect(mcpServersRoute.buildNewHref()).toBe('/account/mcp-servers/new')
	expect(mcpServersRoute.buildNewHref('?tab=oauth')).toBe(
		'/account/mcp-servers/new?tab=oauth',
	)
	expect(mcpServersRoute.buildDetailHref('server 1')).toBe(
		'/account/mcp-servers/server%201',
	)
	expect(mcpServersRoute.buildDetailHref('server 1', '?q=docs')).toBe(
		'/account/mcp-servers/server%201?q=docs',
	)
	expect(mcpServersRoute.buildDetailHref('google.personal')).toBe(
		'/account/mcp-servers/google%2Epersonal',
	)
})

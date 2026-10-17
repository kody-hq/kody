import { connectionsRedirect } from '../../../start/server/legacy-redirects.ts'
import { expect, test } from 'vitest'
import { resolveLegacyOrgConnectionsLocation } from './legacy-org-connections-redirect.ts'

test('legacy /-/connections redirects to /-/agents with the rest of the path and the query', () => {
	const resolve = (path: string) =>
		resolveLegacyOrgConnectionsLocation(new URL(`https://kody.test${path}`))
	expect(resolve('/@acme/-/connections')).toBe('/@acme/-/agents')
	expect(resolve('/@acme/-/connections/')).toBe('/@acme/-/agents')
	expect(resolve('/@acme/-/connections/new/claude-code')).toBe(
		'/@acme/-/agents/new/claude-code',
	)
	expect(resolve('/@acme/-/connections/usage?connection=abc')).toBe(
		'/@acme/-/agents/usage?connection=abc',
	)
	expect(resolve('/@acme/-/connectionsx')).toBeNull()
	expect(resolve('/account/connections')).toBeNull()
})

test('legacy connections handler responds 301 with Location', async () => {
	const response = await connectionsRedirect({
		request: new Request('https://kody.test/@jane/-/connections/new?ref=email'),
	})
	expect(response.status).toBe(301)
	expect(response.headers.get('Location')).toBe('/@jane/-/agents/new?ref=email')
})

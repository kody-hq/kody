import { expect, test } from 'vitest'
import {
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../tools/mcp-test-support.ts'
import { loginToApp } from '../../../tools/mcp-oauth-client.ts'

test('native admin guide HTML stays private and negotiated Markdown retains access checks', async () => {
	const server = await getSharedMcpE2eServer()
	const url = `${server.origin}/docs/admin-events`
	for (const accept of ['text/html', 'text/markdown']) {
		const response = await fetch(url, {
			headers: { Accept: accept },
			redirect: 'manual',
		})
		expect(response.status).toBe(404)
		expect(await response.text()).not.toContain('fleet.entitlement.crossed')
	}
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	await server.assignRole(user.email, 'admin')
	const cookie = await loginToApp(server.origin, user)
	const markdown = await fetch(url, {
		headers: { Cookie: cookie, Accept: 'text/markdown' },
	})
	expect(markdown.status).toBe(200)
	expect(markdown.headers.get('Cache-Control')).toBe('no-store')
	expect(markdown.headers.get('Vary')).toContain('Accept')
	expect(markdown.headers.get('Content-Type')).toContain('text/markdown')
	expect(await markdown.text()).toContain('fleet.entitlement.crossed')
	const html = await fetch(url, { headers: { Cookie: cookie } })
	expect(html.status).toBe(200)
	expect(html.headers.get('Cache-Control')).toContain('no-store')
	expect(await html.text()).toContain('fleet.entitlement.crossed')
})

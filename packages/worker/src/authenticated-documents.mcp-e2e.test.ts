import { expect, test } from 'vitest'
import {
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../tools/mcp-test-support.ts'
import { loginToApp } from '../../../tools/mcp-oauth-client.ts'

function visibleHtml(html: string) {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

test('native account documents render authorized initial state and protect anonymous requests', async () => {
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await loginToApp(server.origin, user)
	const cases = [
		[
			'/account',
			[
				'aria-label="Account sections"',
				'data-testid="account-username"',
				'Display name',
			],
		],
		[
			'/account/security',
			[
				'aria-label="Connected accounts"',
				'href="/account/two-factor"',
				'href="/account/passkeys"',
			],
		],
		['/account/data', ['Download account export', '>Delete account<']],
		[`/@${user.username}/-/webhooks`, ['Webhooks']],
		[
			'/account/organizations',
			[
				'data-testid="account-organizations"',
				'id="invites"',
				'data-testid="invites-empty"',
				'href="/account/organizations/new"',
			],
		],
		['/account/passkeys', ['Passkeys', 'No passkeys yet']],
		[
			'/account/two-factor',
			['Two-factor authentication', 'Two-factor authentication is disabled'],
		],
		['/account/mcp-oauth-clients', ['MCP OAuth clients', 'No clients yet']],
		[
			`/@${user.username}/-/waiting`,
			['Waiting', 'Connect your agent', 'data-testid="waiting-item-first-use"'],
		],
		[
			`/@${user.username}/-/agents`,
			[
				'aria-label="Connected agents"',
				'aria-label="MCP URL"',
				'data-testid="account-connections-add"',
			],
		],
		[
			`/@${user.username}/-/agents/new`,
			['data-testid="account-connections-back"'],
		],
		[`/@${user.username}/-/agents/new/cursor`, ['Connect Cursor']],
	] as const
	for (const [path, markers] of cases) {
		const response = await fetch(new URL(path, server.origin), {
			headers: { Cookie: cookie },
			redirect: 'manual',
		})
		expect.soft(response.status).toBe(200)
		expect.soft(response.headers.get('content-type')).toContain('text/html')
		expect.soft(response.headers.get('cache-control')).toContain('no-store')
		const html = visibleHtml(await response.text())
		for (const marker of markers) expect.soft(html).toContain(marker)
		expect.soft(html).not.toContain('data-testid="internal-error-page"')
		expect.soft(html).not.toContain('aria-label="Session"')
		const anonymous = await fetch(new URL(path, server.origin), {
			redirect: 'manual',
		})
		// Router uses a temporary 307 for GET authorization redirects.
		expect.soft([302, 307]).toContain(anonymous.status)
		expect
			.soft(
				new URL(anonymous.headers.get('location')!, server.origin).pathname,
				path,
			)
			.toBe('/login')
	}
	// Website reads belong to Start. Removed JSON endpoints must not expose account data.
	for (const headers of [new Headers({ Cookie: cookie }), new Headers()]) {
		const retired = await fetch(`${server.origin}/account/organizations.json`, {
			headers,
		})
		expect(retired.status).toBe(404)
	}
	const unknown = await fetch(
		`${server.origin}/@${user.username}/-/agents/new/not-a-client`,
		{ headers: { Cookie: cookie } },
	)
	expect(unknown.status).toBe(404)
})

test('native password reset document renders the token form before hydration', async () => {
	const server = await getSharedMcpE2eServer()
	const response = await fetch(
		`${server.origin}/reset-password?token=reset-token`,
	)
	expect(response.status).toBe(200)
	const html = visibleHtml(await response.text())
	expect(html).toContain('New password')
	expect(html).not.toContain('Send reset link')
})

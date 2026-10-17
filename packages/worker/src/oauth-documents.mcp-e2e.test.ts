import { expect, test } from 'vitest'
import { getSharedMcpE2eServer } from '../../../tools/mcp-test-support.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { oauthAuthorizeClobberedResubmitMessage } from './oauth-authorize-clobber.ts'

function authorizationUrl(origin: string, clientId: string) {
	const url = new URL('/oauth/authorize', origin)
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
		scope: 'profile email',
		state: 'native-document',
		resource: new URL('/mcp', origin).href,
		code_challenge: 'sp23xso5O3jXO-73NoQqSxwu742uqSbPXw1VA8jRfNE',
		code_challenge_method: 'S256',
	}).toString()
	return url
}
async function readDocument(url: URL) {
	const response = await fetch(url, { redirect: 'manual' })
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	expect(response.headers.get('Location')).toBeNull()
	const html = await response.text()
	expect(html).not.toContain('data-testid="internal-error-page"')
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

test('compiled OAuth document renders registered clients, passkeys and configured social controls', async () => {
	const server = await getSharedMcpE2eServer()
	for (const name of ['Claude', 'ChatGPT']) {
		const clientId = `native-${crypto.randomUUID()}`
		await server.seedOAuthClient(clientId, {
			clientId,
			redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
			clientName: name,
			tokenEndpointAuthMethod: 'none',
		})
		try {
			const html = await readDocument(authorizationUrl(server.origin, clientId))
			expect(html).toContain(name)
			expect(html).toContain('data-testid="oauth-authorize-passkey"')
			for (const [provider, label] of [
				['github', 'GitHub'],
				['google', 'Google'],
			]) {
				expect(html).toContain(`aria-label="Continue with ${label}"`)
				expect(html).toContain(`data-testid="social-sign-in-${provider}"`)
			}
		} finally {
			await server.seedOAuthClient(clientId, null)
		}
	}
})

test('compiled OAuth document recovers from malformed and missing client registrations', async () => {
	const server = await getSharedMcpE2eServer()
	const clientId = `native-${crypto.randomUUID()}`
	try {
		await server.seedOAuthClient(clientId, {
			client_id: clientId,
			redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
			client_name: 'Claude',
			token_endpoint_auth_method: 'none',
		})
		expect(
			await readDocument(authorizationUrl(server.origin, clientId)),
		).toContain('Invalid OAuth client registration.')
		await server.seedOAuthClient(clientId, null)
		expect(
			await readDocument(authorizationUrl(server.origin, clientId)),
		).toContain('Invalid client')
	} finally {
		await server.seedOAuthClient(clientId, null)
	}
})

test('compiled OAuth document does not redirect malformed max_age back to itself', async () => {
	const server = await getSharedMcpE2eServer()
	const clientId = `native-${crypto.randomUUID()}`
	await server.seedOAuthClient(clientId, {
		clientId,
		redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
		clientName: 'Claude',
		tokenEndpointAuthMethod: 'none',
	})
	try {
		const url = authorizationUrl(server.origin, clientId)
		url.searchParams.set('scope', 'openid')
		url.searchParams.set('max_age', 'not-a-number')
		expect(await readDocument(url)).toMatch(
			/max_age must be a non-negative integer/i,
		)
	} finally {
		await server.seedOAuthClient(clientId, null)
	}
})

test('compiled OAuth document explains a clobbered pre-hydration request without approving it', async () => {
	const server = await getSharedMcpE2eServer()
	const url = new URL('/oauth/authorize', server.origin)
	url.searchParams.set(honeypotFieldName, '')
	const html = await readDocument(url)
	expect(html).toContain(
		oauthAuthorizeClobberedResubmitMessage.replaceAll("'", '&#x27;'),
	)
	expect(html).not.toContain('client_id is required')
	expect(html).not.toContain('data-testid="oauth-authorize-approve"')
})

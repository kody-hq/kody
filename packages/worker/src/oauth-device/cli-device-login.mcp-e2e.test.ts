import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	createAppSessionCookie,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'

// Loaded by path at runtime so the worker typecheck does not compile the CLI
// sources under the Workers tsconfig (the CLI has its own Node tsconfig).
type CliAuthModule = {
	loginWithDevice: (options: Record<string, unknown>) => Promise<{
		credentials: { accessToken: string }
		org?: string
	}>
}
type CliStoreModule = { createFileBackend: (path: string) => unknown }
const cliSrc = new URL('../../../cli/src/', import.meta.url)
async function loadCli() {
	const auth = (await import(new URL('auth.ts', cliSrc).href)) as CliAuthModule
	const store = (await import(
		new URL('store.ts', cliSrc).href
	)) as CliStoreModule
	return { ...auth, ...store }
}

/**
 * `kody login --device` end to end against the dev worker: the real CLI
 * starts the grant, a signed-in browser session approves it on `/device`, and
 * the CLI's poll receives provider tokens. The dev harness has no Open API
 * host, so the device-token mint (`POST /v1/tokens/device`, unchanged from the
 * browser flow) is answered by a stand-in that checks the OAuth access token
 * against the real `/oauth/userinfo` first.
 */
test('kody login --device signs in through /device approval', async () => {
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await createAppSessionCookie(server.origin, user)
	// The local harness serves plain http, where the provider does not fetch
	// CIMD documents, so register the CLI client the way CIMD would describe it.
	const cliClientId = `${server.origin}/oauth/cli-client-metadata.json`
	await server.seedOAuthClient(cliClientId, {
		clientId: cliClientId,
		redirectUris: ['http://127.0.0.1:43742/callback'],
		clientName: '@kodycodes/cli',
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code', 'refresh_token'],
		responseTypes: ['code'],
		registrationDate: Math.floor(Date.now() / 1000),
	})
	const apiUrl = 'https://api.device-e2e.invalid'
	const seenUserinfo: Array<number> = []
	const fetchFn: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.origin === apiUrl && url.pathname === '/v1/tokens/device') {
			const request = new Request(input, init)
			const userinfo = await fetch(new URL('/oauth/userinfo', server.origin), {
				headers: { Authorization: request.headers.get('Authorization') ?? '' },
			})
			seenUserinfo.push(userinfo.status)
			if (!userinfo.ok) return new Response('unauthorized', { status: 401 })
			return Response.json({
				token: 'kody_at_e2e_device',
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				scopes: ['org:read'],
				login_org: { slug: user.username },
			})
		}
		return fetch(input, init)
	}

	const { loginWithDevice, createFileBackend } = await loadCli()
	let approved = false
	const dir = mkdtempSync(join(tmpdir(), 'kody-device-e2e-'))
	const result = await loginWithDevice({
		mcpUrl: `${server.origin}/mcp`,
		apiUrl,
		fetchFn,
		backend: createFileBackend(join(dir, 'credentials.json')),
		discoverIdentity: async () => ({
			org: user.username,
			account: { email: user.email },
		}),
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5_100))
		},
		onDeviceCode: (prompt: { verificationUri: string; userCode: string }) => {
			expect(prompt.verificationUri).toBe(`${server.origin}/device`)
			expect(prompt.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
			void (async () => {
				const page = await fetch(
					new URL(`/device?user_code=${prompt.userCode}`, server.origin),
					{ headers: { Cookie: cookie } },
				)
				const html = await page.text()
				expect(html).toContain('Only continue if you started this sign-in')
				const decision = await fetch(new URL('/device', server.origin), {
					method: 'POST',
					redirect: 'manual',
					headers: {
						Cookie: cookie,
						Origin: server.origin,
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						user_code: prompt.userCode,
						decision: 'approve',
					}),
				})
				expect(decision.status).toBe(303)
				expect(decision.headers.get('Location')).toBe('/device?result=approved')
				approved = true
			})()
		},
	})
	expect(approved).toBe(true)
	expect(seenUserinfo).toEqual([200])
	expect(result.credentials.accessToken).toBe('kody_at_e2e_device')
	expect(result.org).toBe(user.username)
})

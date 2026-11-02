import { type ClientInfo } from '@cloudflare/workers-oauth-provider'
import { expect, test } from 'vitest'
import { signOidcJwt } from '#worker/oidc/keys.ts'
import { handleOidcLogoutRequest } from '#worker/oidc/logout.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

const issuer = 'https://heykody.dev'
const clientId = 'client-123'
const redirectUri = 'https://rp.example/signed-out'

function createLogoutEnv(input: { withOAuthProvider?: boolean } = {}) {
	return {
		COOKIE_SECRET: 'test-cookie-secret-test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-test-secret-store-key',
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
		...(input.withOAuthProvider === false
			? {}
			: {
					OAUTH_PROVIDER: {
						lookupClient: async (id: string) =>
							id === clientId
								? ({ clientId, redirectUris: [redirectUri] } as ClientInfo)
								: null,
					},
				}),
	} as unknown as Env
}

function logoutUrl(params: Record<string, string>) {
	const url = new URL('/oauth/logout', issuer)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

async function mintIdTokenHint(env: Env, aud: string = clientId) {
	const nowSeconds = Math.floor(Date.now() / 1000)
	return signOidcJwt(env, {
		iss: issuer,
		sub: 'user-stable-id',
		aud,
		iat: nowSeconds,
		exp: nowSeconds + 300,
	})
}

test('logout rejects post_logout_redirect_uri when OAuth helpers are unavailable', async () => {
	const env = createLogoutEnv({ withOAuthProvider: false })
	const response = await handleOidcLogoutRequest(
		new Request(
			logoutUrl({
				post_logout_redirect_uri: redirectUri,
				client_id: clientId,
				id_token_hint: await mintIdTokenHint(env),
			}),
		),
		env,
	)
	expect(response.status).toBe(400)
	expect(await response.text()).toMatch(/Invalid post_logout_redirect_uri/)
})

test('logout refuses a registered post_logout_redirect_uri named only by client_id', async () => {
	const response = await handleOidcLogoutRequest(
		new Request(
			logoutUrl({
				post_logout_redirect_uri: redirectUri,
				client_id: clientId,
			}),
		),
		createLogoutEnv(),
	)
	expect(response.status).toBe(400)
	expect(response.headers.get('Location')).toBeNull()
	expect(response.headers.get('Set-Cookie')).toBeNull()
	expect(await response.text()).toMatch(/requires id_token_hint/)
})

test('logout redirects to a registered post_logout_redirect_uri with a valid id_token_hint', async () => {
	const env = createLogoutEnv()
	const response = await handleOidcLogoutRequest(
		new Request(
			logoutUrl({
				post_logout_redirect_uri: redirectUri,
				id_token_hint: await mintIdTokenHint(env),
				state: 'abc',
			}),
		),
		env,
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(`${redirectUri}?state=abc`)
	expect(response.headers.get('Set-Cookie')).toMatch(/kody_session=/)
})

test('logout without post_logout_redirect_uri signs out with no redirect', async () => {
	const response = await handleOidcLogoutRequest(
		new Request(logoutUrl({})),
		createLogoutEnv(),
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Location')).toBeNull()
	expect(await response.text()).toBe('Signed out.')
})

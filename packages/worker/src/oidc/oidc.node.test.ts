import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { buildOpenIdConfiguration } from '#worker/oidc/discovery.ts'
import {
	getOidcJwksDocument,
	resetOidcSigningKeyCacheForTests,
	verifyOidcJwtSignature,
} from '#worker/oidc/keys.ts'
import { mintIdToken } from '#worker/oidc/id-token.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

function createOidcEnv() {
	return {
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
	} as unknown as Env
}

test('openid-configuration advertises authorization code OIDC only', () => {
	const document = buildOpenIdConfiguration({
		env: createOidcEnv(),
		request: new Request(
			'https://heykody.dev/.well-known/openid-configuration',
		),
	})
	expect(document.response_types_supported).toEqual(['code'])
})

test('jwks accepts PEM secrets stored with literal \\n escapes', async () => {
	resetOidcSigningKeyCacheForTests()
	const env = {
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM.replace(
			/\n/g,
			'\\n',
		),
	} as unknown as Env
	const jwks = await getOidcJwksDocument(env)
	expect(jwks.keys[0]?.kid).toBe(TEST_OIDC_SIGNING_KEY_ID)
	resetOidcSigningKeyCacheForTests()
})

test('minted id_token includes expected claims and verifies with JWKS key', async () => {
	const env = createOidcEnv()
	const request = new Request('https://heykody.dev/oauth/token')
	const idToken = await mintIdToken({
		env,
		request,
		clientId: 'client-123',
		scope: ['openid', 'email', 'profile'],
		props: {
			userId: ownerIdFromStored('user-stable-id'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'Test User',
			authTime: 1_700_000_000,
			nonce: 'nonce-123',
		},
		includeNonce: true,
	})
	const payload = await verifyOidcJwtSignature(env, idToken)
	expect(payload).toMatchObject({
		iss: 'https://heykody.dev',
		sub: 'user-stable-id',
		aud: 'client-123',
		email: 'user@example.com',
		email_verified: true,
		preferred_username: 'test-user',
		name: 'Test User',
		auth_time: 1_700_000_000,
		nonce: 'nonce-123',
	})
	expect(typeof payload?.exp).toBe('number')
	expect(typeof payload?.iat).toBe('number')
})

import { expect, test } from 'vitest'
import {
	evaluateOidcAuthorizeGate,
	getUnsupportedOidcResponseTypeError,
	isOidcAuthorizeParamsParseError,
	parseOidcAuthorizeParams,
} from '#worker/oidc/authorize-oidc.ts'
import { signOidcJwt } from '#worker/oidc/keys.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

const authorizeUrl = 'https://heykody.dev/oauth/authorize'

const oidcTestEnv = {
	OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
	OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} as unknown as Env

async function mintHint(claims: Record<string, unknown>) {
	const now = Math.floor(Date.now() / 1000)
	return signOidcJwt(oidcTestEnv, {
		iss: 'https://heykody.dev',
		aud: 'chatgpt-client',
		iat: now - 7200,
		...claims,
	})
}

test('authorize-oidc rejects implicit and hybrid response types', () => {
	expect(getUnsupportedOidcResponseTypeError('code')).toBeNull()
	for (const responseType of ['id_token', 'code id_token token', 'token']) {
		expect(getUnsupportedOidcResponseTypeError(responseType)).toMatch(
			/authorization code/i,
		)
	}
})

test('authorize-oidc parses nonce prompt max_age and id_token_hint, and rejects malformed or empty max_age', () => {
	expect(
		parseOidcAuthorizeParams(
			new Request(
				`${authorizeUrl}?response_type=code&nonce=demo-nonce&prompt=login&max_age=300&id_token_hint=eyJ.test`,
			),
		),
	).toEqual({
		nonce: 'demo-nonce',
		prompt: 'login',
		maxAge: 300,
		idTokenHint: 'eyJ.test',
		responseType: 'code',
	})
	for (const maxAge of ['300abc', '']) {
		const parsed = parseOidcAuthorizeParams(
			new Request(`${authorizeUrl}?response_type=code&max_age=${maxAge}`),
		)
		expect(isOidcAuthorizeParamsParseError(parsed)).toBe(true)
		expect(parsed).toMatchObject({ errorCode: 'invalid_request' })
	}
})

test('authorize-oidc gate handles prompt and max_age combinations', async () => {
	const cases: Array<{
		params: { prompt?: string; maxAge?: number }
		noSessionIssuedAt?: true
		expected: Record<string, unknown>
	}> = [
		// prompt=none combined with login or consent is contradictory.
		{
			params: { prompt: 'none consent' },
			expected: {
				ok: false,
				error: 'prompt=none cannot be combined with login or consent.',
				errorCode: 'invalid_request',
				status: 400,
			},
		},
		// max_age fails closed without sessionIssuedAt.
		{
			params: { maxAge: 60 },
			noSessionIssuedAt: true,
			expected: {
				ok: true,
				treatAsSignedOut: true,
				forbidInlineLogin: false,
				requireConsent: false,
			},
		},
		// prompt=login requires credentials without clearing cookie intent.
		{
			params: { prompt: 'login' },
			expected: {
				ok: true,
				treatAsSignedOut: true,
				silentAuthorize: undefined,
				requireConsent: false,
			},
		},
		{
			params: { prompt: 'consent' },
			expected: {
				ok: true,
				treatAsSignedOut: false,
				forbidInlineLogin: false,
				requireConsent: true,
			},
		},
		{
			params: { prompt: 'none' },
			expected: {
				ok: true,
				treatAsSignedOut: false,
				forbidInlineLogin: true,
				silentAuthorize: true,
			},
		},
	]
	for (const { params, noSessionIssuedAt, expected } of cases) {
		const result = await evaluateOidcAuthorizeGate({
			params: { ...params, responseType: 'code' },
			session: {
				sessionEmail: 'user@example.com',
				sessionStableUserId: 'user-1',
				sessionIssuedAt: noSessionIssuedAt ? undefined : Date.now(),
			},
			request: new Request(authorizeUrl),
			env: {
				OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
				OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
			} as unknown as Env,
		})
		expect(result).toEqual(expected)
	}
})

test('native authorization parameters do not come from the RPC transport query', () => {
	const request = new Request(
		'https://kody.test/_serverFn/oauth?prompt=none&max_age=999',
	)
	const params = new URLSearchParams(
		'prompt=login&max_age=0&nonce=first&nonce=second',
	)
	expect(parseOidcAuthorizeParams(request, params)).toMatchObject({
		prompt: 'login',
		maxAge: 0,
		nonce: 'first',
	})
	expect(request.url).toContain('/_serverFn/oauth?prompt=none')
})

test('authorize-oidc accepts expired id_token_hint when sub matches the session', async () => {
	const now = Math.floor(Date.now() / 1000)
	const expiredHint = await mintHint({
		sub: 'user-1',
		exp: now - 60,
	})
	const result = await evaluateOidcAuthorizeGate({
		params: { responseType: 'code', idTokenHint: expiredHint },
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request(authorizeUrl),
		env: oidcTestEnv,
	})
	expect(result).toEqual({
		ok: true,
		treatAsSignedOut: false,
		forbidInlineLogin: false,
		requireConsent: false,
	})
})

test('authorize-oidc forces re-auth when id_token_hint sub mismatches the session', async () => {
	const now = Math.floor(Date.now() / 1000)
	const mismatchedHint = await mintHint({
		sub: 'other-user',
		exp: now + 3600,
	})
	const interactive = await evaluateOidcAuthorizeGate({
		params: { responseType: 'code', idTokenHint: mismatchedHint },
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request(authorizeUrl),
		env: oidcTestEnv,
	})
	expect(interactive).toEqual({
		ok: true,
		treatAsSignedOut: true,
		forbidInlineLogin: false,
		requireConsent: false,
	})

	const silent = await evaluateOidcAuthorizeGate({
		params: {
			responseType: 'code',
			prompt: 'none',
			idTokenHint: mismatchedHint,
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request(authorizeUrl),
		env: oidcTestEnv,
	})
	expect(silent).toEqual({
		ok: false,
		error: 'Login required.',
		errorCode: 'login_required',
		status: 401,
	})
})

test('authorize-oidc ignores invalid id_token_hint and keeps a matching session', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: { responseType: 'code', idTokenHint: 'not.a.valid.jwt' },
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request(authorizeUrl),
		env: oidcTestEnv,
	})
	expect(result).toEqual({
		ok: true,
		treatAsSignedOut: false,
		forbidInlineLogin: false,
		requireConsent: false,
	})
})

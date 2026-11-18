import { expect, test } from 'vitest'
import {
	createOauthLoginStateCookie,
	readOauthLoginState,
	setOauthLoginStateSecret,
} from './oauth-login-state.ts'

setOauthLoginStateSecret('test-cookie-secret-for-oauth-login-state')

test('oauth login state cookie round-trips provider, PKCE, and redirect', async () => {
	const state = {
		provider: 'github' as const,
		state: 'csrf-state',
		codeVerifier: 'pkce-verifier',
		redirectTo: '/onboarding',
	}
	const cookie = await createOauthLoginStateCookie(state, false)
	const request = new Request('https://example.com/auth/github/callback', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	expect(await readOauthLoginState(request)).toEqual(state)
})

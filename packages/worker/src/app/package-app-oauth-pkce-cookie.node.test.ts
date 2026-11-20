import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { expect, test } from 'vitest'
import { createPackageAppOauthPkceCookie } from '#app/package-app-oauth-pkce-cookie.ts'
import { packageAppOauthPkceCookieName } from '#universal/package-app-oauth-paths.ts'

test('package-app OAuth PKCE cookie is HttpOnly', async () => {
	resetIsolateState()
	const cookie = await createPackageAppOauthPkceCookie({
		env: {
			COOKIE_SECRET: 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
		} as unknown as Env,
		secure: true,
		state: {
			v: 1,
			verifier: 'test-verifier',
			state: 'test-state',
			returnTo: '/',
			orgUsername: 'owner',
			kodyId: 'demo',
			scopes: ['profile'],
			clientId: 'owner/demo',
		},
	})
	expect(cookie).toMatch(new RegExp(`^${packageAppOauthPkceCookieName}=`))
	expect(cookie).toContain('HttpOnly')
})

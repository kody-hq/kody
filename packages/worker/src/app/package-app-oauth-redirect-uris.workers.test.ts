import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { parsePackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import {
	isAllowedPackageAppOauthRedirectUri,
	listAllowedPackageAppOauthRedirectUris,
} from '#app/package-app-oauth-redirect-uris.ts'
import {
	packageAppOauthLegacyPaths,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'

test('when PACKAGE_APP_BASE_URL is unset, app-origin callback is allowlisted', async () => {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	const previous = mutableEnv.PACKAGE_APP_BASE_URL
	const previousApp = mutableEnv.APP_BASE_URL
	mutableEnv.PACKAGE_APP_BASE_URL = undefined
	mutableEnv.APP_BASE_URL = 'https://kody-pr-3889.kody-a99.workers.dev'
	try {
		const client = parsePackageAppOauthClientId('user-me/consent-demo')
		expect(client).not.toBeNull()
		if (!client) return
		const allowed = await listAllowedPackageAppOauthRedirectUris({
			env,
			client,
		})
		const expected = `https://kody-pr-3889.kody-a99.workers.dev${packageAppOauthPaths.callback}`
		expect(allowed).toContain(expected)
		const legacy = `https://kody-pr-3889.kody-a99.workers.dev${packageAppOauthLegacyPaths.callback}`
		expect(allowed).toContain(legacy)
		expect(
			await isAllowedPackageAppOauthRedirectUri({
				env,
				client,
				redirectUri: legacy,
			}),
		).toBe(true)
		expect(
			await isAllowedPackageAppOauthRedirectUri({
				env,
				client,
				redirectUri: expected,
			}),
		).toBe(true)
	} finally {
		mutableEnv.PACKAGE_APP_BASE_URL = previous
		mutableEnv.APP_BASE_URL = previousApp
	}
})

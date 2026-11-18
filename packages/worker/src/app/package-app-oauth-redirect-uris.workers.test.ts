import { env } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePackageAppCustomHostnamesTestSchema } from '#worker/test-support/package-app-custom-hostnames-test-schema.ts'
import { ensurePackageSubscriptionTestSchema } from '#worker/test-support/workers-seed.ts'
import { parsePackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import {
	isAllowedPackageAppOauthRedirectUri,
	listAllowedPackageAppOauthRedirectUris,
} from '#app/package-app-oauth-redirect-uris.ts'
import {
	packageAppOauthLegacyPaths,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'

beforeEach(async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensurePackageAppCustomHostnamesTestSchema()
})

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

test("the app's own {leaf}--{handle} host callback is allowlisted next to the owner subdomain", async () => {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	const previous = mutableEnv.PACKAGE_APP_BASE_URL
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	try {
		const client = parsePackageAppOauthClientId('user-me/consent-demo')
		expect(client).not.toBeNull()
		if (!client) return
		const allowed = await listAllowedPackageAppOauthRedirectUris({
			env,
			client,
		})
		expect(allowed).toContain(
			`https://consent-demo--user-me.packages.isolated.test${packageAppOauthPaths.callback}`,
		)
		expect(allowed).toContain(
			`https://user-me.packages.isolated.test${packageAppOauthPaths.callback}`,
		)
		// Another app's host is a different origin and never allowlisted.
		expect(
			await isAllowedPackageAppOauthRedirectUri({
				env,
				client,
				redirectUri: `https://other--user-me.packages.isolated.test${packageAppOauthPaths.callback}`,
			}),
		).toBe(false)
	} finally {
		mutableEnv.PACKAGE_APP_BASE_URL = previous
	}
})

import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { LoginPage } from './pages/login.tsx'
import { OAuthAuthorizeRoute } from './pages/oauth-authorize.tsx'
import { type SessionInfo } from '#client/session.ts'
import { featureFlagKeys } from '#universal/feature-flags/registry.ts'
import { type OAuthAuthorizeLoaderData } from '#universal/loader-data.ts'

const authConfig = {
	turnstileSiteKey: null,
	providers: ['GitHub', 'Google', 'X', 'Discord'].map((label) => ({
		id: label.toLowerCase(),
		label,
	})),
}
const authorizePath =
	'/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile'
function authorization(
	emailVerified: boolean | null,
): Extract<OAuthAuthorizeLoaderData, { ok: true }> {
	return {
		ok: true,
		client: { id: 'client-1', name: 'Cursor' },
		scopes: ['profile', 'email'],
		emailVerified,
		requireCredentials: false,
		orgs: [{ slug: 'ada', displayName: 'Ada', role: 'owner' }],
		selectedOrgSlug: 'ada',
	}
}

test('native signup renders accessible social provider controls before hydration', async () => {
	const html = await renderStartPage(
		createElement(LoginPage, {
			mode: 'signup',
			currentHref: '/signup',
			authConfig,
		}),
		'/signup',
	)
	for (const { label } of authConfig.providers)
		expect(html).toContain(`aria-label="Continue with ${label}"`)
})

test('native OAuth document renders grant, scopes, and POST action with consent disabled before hydration', async () => {
	const html = await renderStartPage(
		createElement(OAuthAuthorizeRoute, {
			data: authorization(null),
			session: null,
			authProviders: authConfig,
		}),
		authorizePath,
	)
	for (const expected of [
		'data-testid="oauth-authorize-grant"',
		'This agent gets full access in @ada',
		'data-testid="oauth-authorize-org"',
		'data-testid="oauth-authorize-oidc-scopes"',
		'<code>profile</code>',
		'<code>email</code>',
		'data-testid="oauth-authorize-form"',
		'method="post"',
		'action="/oauth/authorize?response_type=code&amp;client_id=client-1',
		'name="decision"',
		'value="approve"',
		'aria-busy="true"',
	])
		expect(html).toContain(expected)
	for (const absent of [
		'OAuth authorization failed',
		'Unknown client',
		'Loading authorization details',
	])
		expect(html).not.toContain(absent)
	expect(html).toMatch(/data-testid="oauth-authorize-approve"[^>]*disabled/)
})

test('native OAuth document requires email verification before granting access', async () => {
	const session: SessionInfo = {
		email: 'ada@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'ada',
		avatarUrl: null,
		roles: ['user'],
		permissions: [],
		featureFlags: Object.fromEntries(
			featureFlagKeys.map((key) => [key, false]),
		) as SessionInfo['featureFlags'],
	}
	const html = await renderStartPage(
		createElement(OAuthAuthorizeRoute, {
			data: authorization(false),
			session,
			authProviders: authConfig,
		}),
		authorizePath,
	)
	expect(html).toContain('aria-label="Email verification status"')
	expect(html).not.toContain('Approve connection')
	expect(html).toMatch(
		/data-testid="oauth-authorize-email-verify-deny"[^>]*disabled/,
	)
})

test('native OAuth document omits unconfigured social providers and keeps passkey sign-in', async () => {
	const html = await renderStartPage(
		createElement(OAuthAuthorizeRoute, {
			data: { ...authorization(null), requireCredentials: true },
			session: null,
			authProviders: { turnstileSiteKey: null, providers: [] },
		}),
		authorizePath,
	)
	expect(html).toContain('data-testid="oauth-authorize-passkey"')
	for (const label of ['GitHub', 'Google']) {
		expect(html).not.toContain(`aria-label="Continue with ${label}"`)
	}
})

import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { PackageAppOauthConsentPage } from './package-app-oauth-consent.tsx'
import { type PackageAppOauthConsentLoaderData } from '#universal/loader-data.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
const href = `${packageAppOauthPaths.authorize}?client_id=acme%2Fdemo&redirect_uri=https%3A%2F%2Facme.kody.run%2F_kody%2Fauth%2Fcallback&response_type=code&code_challenge=abc&code_challenge_method=S256&scope=email&state=s1`

const loaderData: PackageAppOauthConsentLoaderData = {
	ok: true,
	packageName: 'demo',
	iconUrl: null,
	publisherDisplayName: 'Acme Apps',
	publisherUsername: 'acme',
	appDomain: 'acme.kody.run',
	viewerDisplayName: 'Ada',
	clientId: 'acme/demo',
	kodyId: 'demo',
	redirectUri: 'https://acme.kody.run/_kody/auth/callback',
	scopes: ['profile', 'email'],
	claimLabels: [
		'See your name, username, and avatar',
		'See your access level for this app',
		'See your email address',
	],
	hiddenFields: {
		client_id: 'acme/demo',
		redirect_uri: 'https://acme.kody.run/_kody/auth/callback',
		response_type: 'code',
		code_challenge: 'abc',
		code_challenge_method: 'S256',
		scope: 'email',
		state: 's1',
	},
}

test('package-app OAuth consent renders Kody shell fields', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, { data: loaderData }),
		href,
	)

	expect(html).toContain('data-testid="package-app-oauth-consent"')
	expect(html).toContain('Allow demo?')
	const publisherText = html
		.match(/<p\b[^>]*>Published by[\s\S]*?<\/p>/)?.[0]
		.replace(/<!--[\s\S]*?-->|<[^>]+>/g, '')
	expect(publisherText).toBe('Published by Acme Apps (@acme)')
	expect(html).toContain('acme.kody.run')
	expect(html).toContain('See your email address')
	expect(html).toContain('data-testid="package-app-oauth-approve"')
	expect(html).toContain('>Allow<')
	expect(html).toContain('>Cancel<')
	expect(html).toContain('data-testid="package-app-oauth-consent-details"')
	expect(html).toContain('Client ID')
	const detailsIndex = html.indexOf(
		'data-testid="package-app-oauth-consent-details"',
	)
	expect(detailsIndex).toBeGreaterThan(-1)
	const details = html.slice(detailsIndex)
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
	expect(html.slice(0, detailsIndex)).not.toContain('acme/demo')
})

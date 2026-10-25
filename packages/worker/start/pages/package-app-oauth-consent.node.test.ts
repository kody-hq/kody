import { createElement } from 'react'
import { expect, test, vi } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { PackageAppOauthConsentPage } from './package-app-oauth-consent.tsx'
import { type PackageAppOauthConsentLoaderData } from '#universal/loader-data.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'

const advancedView = vi.hoisted(() => ({ enabled: false }))

vi.mock('react', async (importOriginal) => {
	const actual = await importOriginal<typeof import('react')>()
	return {
		...actual,
		useState(initial: unknown) {
			if (advancedView.enabled) {
				const initialValue =
					typeof initial === 'function' ? (initial as () => unknown)() : initial
				if (initialValue instanceof Set && initialValue.size === 0) {
					return actual.useState(() => new Set(['calendar']))
				}
			}
			return actual.useState(initial as never)
		},
	}
})

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
	requiredScopes: ['profile'],
	alreadyAllowedScopes: [],
	requiredLabels: [
		'See your name, username, and avatar',
		'See your access level for this app',
	],
	claimLabels: [
		'See your name, username, and avatar',
		'See your access level for this app',
		'See your email address',
	],
	optionalScopes: [{ scope: 'email', label: 'See your email address' }],
	executorNeeds: [],
	alreadyAllowedLabels: [],
	hiddenFields: {
		client_id: 'acme/demo',
		redirect_uri: 'https://acme.kody.run/_kody/auth/callback',
		response_type: 'code',
		code_challenge: 'abc',
		code_challenge_method: 'S256',
		scope: 'profile email',
		state: 's1',
	},
}

test('package-app OAuth consent renders Kody shell fields', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, { data: loaderData }),
		href,
	)
	const renderedForm = new URLSearchParams()
	for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
		const attributes = tag[0]
		const attribute = (name: string) =>
			attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1]
		const name = attribute('name')
		const value = attribute('value')
		const type = attribute('type')
		const checked = /\schecked(?:="")?(?:\s|\/?>)/.test(attributes)
		if (name && value !== undefined && (type === 'hidden' || checked)) {
			renderedForm.append(
				name,
				value
					.replaceAll('&amp;', '&')
					.replaceAll('&quot;', '"')
					.replaceAll('&#x27;', "'")
					.replaceAll('&lt;', '<')
					.replaceAll('&gt;', '>'),
			)
		}
	}

	expect(html).toContain('data-testid="package-app-oauth-consent"')
	expect(html).toContain('Allow demo?')
	const publisherText = html
		.match(/<p\b[^>]*>Published by[\s\S]*?<\/p>/)?.[0]
		.replace(/<!--[\s\S]*?-->|<[^>]+>/g, '')
	expect(publisherText).toBe('Published by Acme Apps (@acme)')
	expect(html).toContain('acme.kody.run')
	expect(html).toContain('See your email address')
	expect(html).toContain('type="checkbox"')
	expect(html).toMatch(/name="selected_scopes"[^>]*value="email"/)
	expect(html).toContain('form="package-app-oauth-consent-form"')
	expect(html).toContain('id="package-app-oauth-consent-form"')
	expect(html).toMatch(/type="checkbox"[^>]*checked/)
	expect(html).toContain('name="selected_scopes" value="profile"')
	expect(html).toContain(
		'Email visibility does not grant permission to send email',
	)
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
	expect(renderedForm.get('scope')).toBe('profile email')
	expect(renderedForm.getAll('selected_scopes')).toEqual(['email', 'profile'])
})

test('flag-off consent keeps standard scopes without executor credentials', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: { ...loaderData, executorNeeds: [] },
		}),
		href,
	)

	expect(html).toContain('See your email address')
	expect(html).toMatch(/name="selected_scopes"[^>]*value="email"/)
	expect(html).not.toContain('Required credentials')
	expect(html).not.toContain('Create new credentials')
})

test('package-app OAuth consent hides an empty already allowed section', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				alreadyAllowedScopes: ['profile'],
				alreadyAllowedLabels: [],
			},
		}),
		href,
	)

	expect(html).not.toContain('Already allowed:')
})

test('package-app OAuth consent recommends one credential and hides alternates initially', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				scopes: ['profile', 'email', 'need:calendar'],
				requiredScopes: ['profile', 'need:calendar'],
				hiddenFields: {
					...loaderData.hiddenFields,
					scope: 'profile email need:calendar',
				},
				executorNeeds: [
					{
						key: 'calendar',
						description: 'Calendar access for this app',
						required: true,
						scope: 'need:calendar',
						credentials: [
							{
								id: 'credential-one',
								name: 'Calendar credentials',
								usedByApps: 2,
							},
							{
								id: 'credential-two',
								name: 'Other calendar credentials',
								usedByApps: 0,
							},
						],
						recommendedCredentialId: 'credential-one',
						createUrl: '/@viewer/-/credentials/new?name=calendar',
					},
				],
			},
		}),
		href,
	)

	expect(html).toContain('Required credentials')
	expect(html).toContain('Calendar access for this app')
	expect(html).toContain('Calendar credentials')
	expect(html).toContain('Used by ')
	expect(html).toContain('>2<')
	expect(html).toContain('Choose another credential')
	expect(html).not.toContain('Other calendar credentials')
	expect(html).toContain('Create new credentials')
	expect(html).toMatch(
		/<input[^>]*name="credential_need:calendar"[^>]*checked=""[^>]*value="credential-one"/,
	)
	expect(html).toContain('name="selected_scopes" value="need:calendar"')
	expect(html).not.toMatch(
		/<input[^>]*type="checkbox"[^>]*value="need:calendar"/,
	)
	expect(html.replace(/<input\b[^>]*>/g, '')).not.toContain('credential-one')
	expect(html.replace(/<input\b[^>]*>/g, '')).not.toContain('credential-two')
})

test('package-app consent advanced credential view lists every matching credential', async () => {
	advancedView.enabled = true
	try {
		const html = await renderStartPage(
			createElement(PackageAppOauthConsentPage, {
				data: {
					...loaderData,
					executorNeeds: [
						{
							key: 'calendar',
							description: 'Calendar access for this app',
							required: true,
							scope: 'need:calendar',
							credentials: [
								{
									id: 'credential-one',
									name: 'Calendar credentials',
									usedByApps: 3,
								},
								{
									id: 'credential-two',
									name: 'Work calendar credentials',
									usedByApps: 1,
								},
								{
									id: 'credential-three',
									name: 'Personal calendar credentials',
									usedByApps: 0,
								},
							],
							recommendedCredentialId: 'credential-one',
							createUrl: '/@viewer/-/credentials/new?name=calendar',
						},
					],
				},
			}),
			href,
		)
		expect(html).toContain('Calendar credentials')
		expect(html).toContain('Work calendar credentials')
		expect(html).toContain('Personal calendar credentials')
		const text = html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, '')
		expect(text).toContain('Used by 3 apps')
		expect(text).toContain('Used by 1 apps')
		expect(text).toContain('Used by 0 apps')
	} finally {
		advancedView.enabled = false
	}
})

test('package-app consent offers Create new credentials when no candidate matches', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				executorNeeds: [
					{
						key: 'calendar',
						description: 'Calendar access for this app',
						required: true,
						scope: 'need:calendar',
						credentials: [],
						recommendedCredentialId: null,
						createUrl: '/@viewer/-/credentials/new?name=calendar',
					},
				],
			},
		}),
		href,
	)

	expect(html).toContain('No matching credentials are available yet.')
	expect(html).toContain('Create new credentials')
	expect(html).not.toContain('type="radio"')
	const approveButton = html.match(
		/<button\b[^>]*data-testid="package-app-oauth-approve"[^>]*>/,
	)?.[0]
	expect(approveButton).toContain('disabled=""')
	expect(html).toContain(
		'Create a matching credential before allowing this app.',
	)
})

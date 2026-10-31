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
	device: null,
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
	expect(html).not.toContain('package-app-oauth-need-create-')
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
						provider: 'google-calendar',
						kindLabel: 'OAuth',
						createDestination: 'viewer',
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
	// Alternates sit in a closed native <details> (works without JavaScript).
	expect(html).toMatch(
		/<details[^>]*>\s*<summary>Choose another credential<\/summary>/,
	)
	expect(html).not.toMatch(/<details[^>]*\bopen\b/)
	expect(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, '')).toContain(
		'Create a google-calendar OAuth credential',
	)
	expect(html).not.toContain('package-app-oauth-need-missing-calendar')
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
							provider: 'google-calendar',
							kindLabel: 'OAuth',
							createDestination: 'viewer',
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

test('package-app consent names the wanted credential and blocks Allow next to a missing required need', async () => {
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
						provider: 'google-calendar',
						kindLabel: 'OAuth',
						createDestination: 'viewer',
					},
				],
			},
		}),
		href,
	)

	const text = html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, '')
	expect(text).toContain('No google-calendar credential yet.')
	expect(text).toContain('Create a google-calendar OAuth credential in @viewer')
	expect(html).toContain('package-app-oauth-need-create-calendar')
	expect(html).not.toContain('type="radio"')
	const approveButton = html.match(
		/<button\b[^>]*data-testid="package-app-oauth-approve"[^>]*>/,
	)?.[0]
	expect(approveButton).toContain('disabled=""')
	expect(approveButton).toContain(
		'aria-describedby="package-app-oauth-allow-blocked"',
	)
	const missing = html.indexOf('package-app-oauth-need-missing-calendar')
	expect(missing).toBeGreaterThan(-1)
	expect(missing).toBeLessThan(html.indexOf('package-app-oauth-approve'))
	expect(text).toContain(
		'Required: create a google-calendar OAuth credential to allow this app.',
	)
})

const optionalChatNeed = {
	key: 'chat',
	description: 'Chat access for this app',
	required: false,
	scope: 'need:chat',
	credentials: [],
	recommendedCredentialId: null,
	createUrl: '/@viewer/-/credentials/new?name=chat',
	provider: 'chat-provider',
	kindLabel: null,
	createDestination: 'viewer',
}

function approveButtonOf(html: string) {
	return html.match(
		/<button\b[^>]*data-testid="package-app-oauth-approve"[^>]*>/,
	)?.[0]
}

test('package-app consent starts a new optional executor need unchecked', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				optionalScopes: [
					...loaderData.optionalScopes,
					{ scope: 'need:chat', label: 'Chat access for this app' },
				],
				executorNeeds: [optionalChatNeed],
			},
		}),
		href,
	)

	const checkbox = html.match(
		/<input\b[^>]*value="need:chat"[^>]*>|<input\b[^>]*name="need:chat"[^>]*>/,
	)?.[0]
	expect(checkbox).toBeDefined()
	expect(checkbox).not.toContain('checked')
	expect(approveButtonOf(html)).not.toContain('disabled=""')
})

test('package-app consent blocks Allow when an already allowed optional need lost its credential', async () => {
	const html = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				alreadyAllowedScopes: ['need:chat'],
				executorNeeds: [optionalChatNeed],
			},
		}),
		href,
	)

	expect(approveButtonOf(html)).toContain('disabled=""')
})

test('package-app OAuth consent says who pays for the visit', async () => {
	const outside = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: {
				...loaderData,
				billing: { payer: 'visitor-org', orgSlug: 'ada' },
			},
		}),
		href,
	)
	expect(outside).toContain('data-testid="package-app-oauth-who-pays"')
	expect(outside).toContain('your org (@ada) pays for the metered work')
	const publisher = await renderStartPage(
		createElement(PackageAppOauthConsentPage, {
			data: { ...loaderData, billing: { payer: 'publisher' } },
		}),
		href,
	)
	expect(publisher).toContain('the publisher pays for what this app runs')
})

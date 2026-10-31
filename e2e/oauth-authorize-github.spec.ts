import { createHash, randomBytes } from 'node:crypto'
import { type APIRequestContext } from '@playwright/test'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { completeUsernameChoice } from './complete-username-choice.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	executeE2eD1Command,
} from './d1-utils.ts'
import { buildDeleteUserAndPersonalOrgSql } from '../tools/seed-sql.ts'

const mockGithubEmail = 'mock-github-user@example.com'
const callbackRedirectUri = 'https://example.com/oauth/callback'

function createS256CodeChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url')
}

function createCodeVerifier() {
	return randomBytes(32).toString('base64url')
}

async function resetMockGithubUser() {
	executeE2eD1Command(
		`DELETE FROM oauth_connections WHERE provider_id = 'mock-github-user-1';
${buildDeleteUserAndPersonalOrgSql({
	emails: [mockGithubEmail],
	orphanPersonalOrgSlugs: ['mock-octo'],
})}`,
	)
	clearAuthRateLimitsInE2eDatabase()
}

async function registerPublicClient(request: APIRequestContext) {
	const response = await request.post('/oauth/register', {
		data: {
			redirect_uris: [callbackRedirectUri],
			client_name: 'E2E GitHub Authorize Client',
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		},
	})
	expect(response.ok()).toBeTruthy()
	const payload = (await response.json()) as { client_id: string }
	expect(payload.client_id).toBeTruthy()
	return payload.client_id
}

function buildAuthorizePath(input: {
	clientId: string
	verifier: string
	state: string
	prompt?: string
}) {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: input.clientId,
		redirect_uri: callbackRedirectUri,
		scope: 'profile email',
		code_challenge: createS256CodeChallenge(input.verifier),
		code_challenge_method: 'S256',
		state: input.state,
	})
	if (input.prompt) params.set('prompt', input.prompt)
	return `/oauth/authorize?${params.toString()}`
}

test('GitHub sign-in from authorize returns with OAuth params intact', async ({
	page,
	request,
}) => {
	await resetMockGithubUser()
	await page.context().clearCookies()

	const clientId = await registerPublicClient(request)
	const verifier = createCodeVerifier()
	const state = `from-authorize-${createCodeVerifier()}`
	const authorizePath = buildAuthorizePath({
		clientId,
		verifier,
		state,
		prompt: 'login',
	})

	const configReads: string[] = []
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/auth/providers.json')
			configReads.push(request.url())
	})
	await page.goto(authorizePath)
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	expect(configReads).toEqual([])
	await expect(page.getByTestId('oauth-authorize-passkey')).toBeEnabled()
	await page.getByRole('button', { name: 'Show password', exact: true }).click()
	await expect(page.locator('input[name="password"]')).toHaveAttribute(
		'type',
		'text',
	)
	await page.getByRole('button', { name: 'Hide password', exact: true }).click()

	await expect(
		page.getByRole('heading', { name: 'Authorize access' }),
	).toBeVisible()
	await expect(page.locator('input[name="password"]')).toBeVisible()
	const githubButton = page.getByRole('button', {
		name: 'Continue with GitHub',
	})
	await expect(githubButton).toBeVisible()

	await githubButton.click()

	// New GitHub account parks on username choice, then resumes authorize
	// (explicit redirectTo wins); prompt=login is stripped after create.
	await expect(page).toHaveURL(/\/signup\/choose-username/)
	await expect(
		page.getByRole('link', { name: 'Start over', exact: true }),
	).toHaveAttribute(
		'href',
		`/signup?${new URLSearchParams({ redirectTo: authorizePath })}`,
	)
	await completeUsernameChoice(page, 'mock-octo')
	await expect(page).toHaveURL(/\/oauth\/authorize\?/)
	await expect(page).not.toHaveURL(/prompt=login/)
	await expect(page).toHaveURL(new RegExp(`client_id=${clientId}`))
	await expect(page).toHaveURL(new RegExp(`state=${state}`))
	await expect(page).toHaveURL(
		new RegExp(`redirect_uri=${encodeURIComponent(callbackRedirectUri)}`),
	)
	await expect(page).toHaveURL(/code_challenge=/)
	await expect(page).toHaveURL(/code_challenge_method=S256/)

	await waitForClientHydration(page)
	await expect(page.getByText(/Signed in as/i)).toBeVisible()
	await expect(page.locator('input[name="password"]')).toHaveCount(0)

	await page.getByTestId('oauth-authorize-approve').click()
	await expect(page).toHaveURL(
		new RegExp(
			`^${callbackRedirectUri.replace(/\./g, '\\.')}\\?.*code=.*state=${state}`,
		),
	)
})

for (const change of ['expired', 'switched'] as const) {
	test(`consent reloads before approving when the session ${change}`, async ({
		page,
		request,
		seedE2eUser,
		login,
	}) => {
		const suffix = randomBytes(6).toString('hex')
		const user = await seedE2eUser({
			email: `consent-${suffix}@example.com`,
			username: `consent-${suffix}`,
			password: 'consent-session-password',
		})
		await login({ email: user.email, password: user.password, mode: 'login' })
		const authorizePath = buildAuthorizePath({
			clientId: await registerPublicClient(request),
			verifier: createCodeVerifier(),
			state: `identity-${suffix}`,
		})
		await page.goto(authorizePath)
		await waitForClientHydration(page)
		await expect(page.getByTestId('oauth-authorize-approve')).toBeVisible()

		let nextUsername: string | undefined
		if (change === 'expired') {
			await page.context().clearCookies()
		} else {
			const other = await seedE2eUser({
				email: `consent-other-${suffix}@example.com`,
				username: `consent-other-${suffix}`,
				password: 'consent-other-password',
			})
			nextUsername = other.username
			await login({
				email: other.email,
				password: other.password,
				mode: 'login',
			})
		}
		const callbackRequests: string[] = []
		page.on('request', (outgoing) => {
			if (outgoing.url().startsWith(callbackRedirectUri)) {
				callbackRequests.push(outgoing.url())
			}
		})
		const reloaded = page.waitForRequest(
			(outgoing) =>
				outgoing.isNavigationRequest() &&
				new URL(outgoing.url()).pathname === '/oauth/authorize',
		)
		await page.getByTestId('oauth-authorize-approve').click()
		await reloaded
		await expect(page).toHaveURL(
			(url) => `${url.pathname}${url.search}` === authorizePath,
		)
		await waitForClientHydration(page)
		if (nextUsername) {
			await expect(
				page.getByText(`Signed in as ${nextUsername}`, { exact: true }),
			).toBeVisible()
		} else {
			await expect(page.locator('input[name="password"]')).toBeVisible()
		}
		expect(callbackRequests).toEqual([])
	})
}

import { createHash, randomBytes } from 'node:crypto'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

const callbackRedirectUri = 'https://example.com/oauth/callback'

test('Try it out creates a guest and finishes the same OAuth flow', async ({
	page,
	request,
}) => {
	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()
	const registered = await request.post('/oauth/register', {
		data: {
			redirect_uris: [callbackRedirectUri],
			client_name: 'E2E Guest Client',
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		},
	})
	expect(registered.ok()).toBeTruthy()
	const { client_id: clientId } = (await registered.json()) as {
		client_id: string
	}
	const verifier = randomBytes(32).toString('base64url')
	const state = `guest-${randomBytes(8).toString('hex')}`
	const authorizePath = `/oauth/authorize?${new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: callbackRedirectUri,
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256',
		state,
	})}`

	await page.goto(authorizePath)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', {
			name: 'E2E Guest Client wants to connect to your Kody account',
		}),
	).toBeVisible()
	await expect(page.getByTestId('oauth-authorize-login')).toBeVisible()
	await expect(page.getByTestId('oauth-authorize-signup')).toBeVisible()
	await page.getByTestId('oauth-authorize-try-it-out').click()

	const connected = page.getByTestId('oauth-authorize-guest-connected')
	await expect(connected).toBeVisible()
	await expect(page.getByTestId('oauth-authorize-guest-claim-url')).toHaveText(
		/\/claim\/[A-Za-z0-9_-]+$/,
	)
	await expect(connected).toContainText('Full access until')
	await expect(connected).not.toContainText('\u2014')

	const returnLink = page.getByTestId('oauth-authorize-guest-return')
	await expect(returnLink).toHaveText('Return to E2E Guest Client')
	const href = await returnLink.getAttribute('href')
	expect(href).toBeTruthy()
	const callback = new URL(href!)
	expect(`${callback.origin}${callback.pathname}`).toBe(callbackRedirectUri)
	expect(callback.searchParams.get('state')).toBe(state)
	const code = callback.searchParams.get('code')
	expect(code).toBeTruthy()

	const token = await request.post('/oauth/token', {
		form: {
			grant_type: 'authorization_code',
			code: code!,
			client_id: clientId,
			redirect_uri: callbackRedirectUri,
			code_verifier: verifier,
		},
	})
	expect(token.ok()).toBeTruthy()
	const { access_token: accessToken } = (await token.json()) as {
		access_token: string
	}
	expect(accessToken).toBeTruthy()
})

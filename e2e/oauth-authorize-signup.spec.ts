import { createHash, randomBytes } from 'node:crypto'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	deleteUserInE2eDatabase,
} from './d1-utils.ts'
import {
	extractVerifyEmailPath,
	findVerificationEmail,
	listE2eCloudflareMockMessages,
	type MockEmailMessage,
} from './cloudflare-mock.ts'

const callbackRedirectUri = 'https://example.com/oauth/callback'

test('a new person signs up from the authorize page and finishes the same OAuth flow', async ({
	page,
	request,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const email = `e2e-oauth-signup-${runId}@example.com`
	const username = `e2e-os-${runId}`
	const password = 'e2e-oauth-signup-password'
	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	const registered = await request.post('/oauth/register', {
		data: {
			redirect_uris: [callbackRedirectUri],
			client_name: 'E2E Signup Authorize Client',
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
	const state = `signup-${randomBytes(8).toString('hex')}`
	const authorizeParams = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: callbackRedirectUri,
		scope: 'profile email',
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256',
		state,
	})
	const authorizePath = `/oauth/authorize?${authorizeParams}`
	const signupHref = `/signup?${new URLSearchParams({ redirectTo: authorizePath })}`

	try {
		await page.goto(authorizePath)
		await waitForClientHydration(page)
		const signupLink = page
			.getByTestId('oauth-authorize-signup')
			.getByRole('link', { name: 'Create an account' })
		await expect(signupLink).toHaveAttribute('href', signupHref)
		// The footer sign-up link keeps the pending authorization too.
		await expect(
			page.getByRole('contentinfo').getByRole('link', { name: 'home' }),
		).toHaveAttribute('href', signupHref)

		await signupLink.click()
		await expect(page).toHaveURL(signupHref)
		await waitForClientHydration(page)
		await page.getByRole('textbox', { name: 'Username' }).fill(username)
		await page.getByLabel('Email').fill(email)
		await page.getByLabel('Password', { exact: true }).fill(password)
		await expect(
			page.getByRole('status').filter({ hasText: `${username} is available` }),
		).toBeVisible()
		await page
			.getByRole('button', { name: 'Create account', exact: true })
			.click()
		await page.getByRole('button', { name: 'Yes, create account' }).click()
		await expect(page).toHaveURL(/\/pending-verification\?/)
		expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(
			authorizePath,
		)

		let verificationEmail = null as MockEmailMessage | null
		await expect
			.poll(
				async () => {
					const payload = await listE2eCloudflareMockMessages()
					verificationEmail = findVerificationEmail(payload.messages, email)
					return verificationEmail
				},
				{ timeout: 15_000 },
			)
			.not.toBeNull()
		const verifyPath = extractVerifyEmailPath(
			`${verificationEmail?.text ?? ''}\n${verificationEmail?.html ?? ''}`,
		)
		if (!verifyPath) throw new Error('Verification email had no link.')
		expect(
			new URL(verifyPath, 'https://kody.local').searchParams.get('redirectTo'),
		).toBe(authorizePath)

		await page.goto(verifyPath)
		await expect(
			page.getByRole('heading', { name: 'Email verified' }),
		).toBeVisible()
		await page.getByRole('link', { name: 'Continue authorization' }).click()
		await expect(page).toHaveURL(/\/oauth\/authorize\?/)
		expect(new URL(page.url()).searchParams.toString()).toBe(
			authorizeParams.toString(),
		)
		await waitForClientHydration(page)
		await expect(page.getByText(/Signed in as/i)).toBeVisible()

		await page.route(`${callbackRedirectUri}**`, (route) =>
			route.fulfill({ status: 200, body: 'ok' }),
		)
		await page.getByTestId('oauth-authorize-approve').click()
		await expect(page).toHaveURL(
			new RegExp(`^${callbackRedirectUri.replace(/\./g, '\\.')}\\?`),
		)
		const callback = new URL(page.url())
		expect(callback.searchParams.get('state')).toBe(state)
		const code = callback.searchParams.get('code')
		expect(code).toBeTruthy()

		const token = await request.post('/oauth/token', {
			form: {
				grant_type: 'authorization_code',
				code: code ?? '',
				redirect_uri: callbackRedirectUri,
				client_id: clientId,
				code_verifier: verifier,
			},
		})
		expect(token.status()).toBe(200)
		const tokens = (await token.json()) as { access_token?: string }
		expect(tokens.access_token).toBeTruthy()
	} finally {
		deleteUserInE2eDatabase(email)
	}
})

import { generateTOTP } from '@epic-web/totp'
import {
	type Page,
	expect,
	test,
	waitForClientHydration,
} from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

// WebAuthn relying party ids must be domains, not IP addresses, so passkey
// tests navigate via localhost instead of the default 127.0.0.1 base URL.
// The login fixture already registers the session cookie for localhost.
function localhostUrl(baseURL: string | undefined, pathname: string) {
	const url = new URL(pathname, baseURL ?? 'http://127.0.0.1:3847')
	url.hostname = 'localhost'
	return url.toString()
}

async function gotoLocalhost(
	page: Page,
	baseURL: string | undefined,
	pathname: string,
) {
	// Prefer domcontentloaded: under CI load the full `load` event can stall on
	// late assets while the app shell is already interactive. Hydration still
	// has to finish before JS-only `type="button"` clicks (register, enable 2FA,
	// passkey sign-in, delete) or they are silent no-ops — same race #1628
	// fixed in the two-factor spec.
	await page.goto(localhostUrl(baseURL, pathname), {
		waitUntil: 'domcontentloaded',
	})
	await waitForClientHydration(page)
}

async function addVirtualAuthenticator(page: Page) {
	const client = await page.context().newCDPSession(page)
	await client.send('WebAuthn.enable')
	const { authenticatorId } = await client.send(
		'WebAuthn.addVirtualAuthenticator',
		{
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	)
	return { client, authenticatorId }
}

test('passkey lifecycle: reject unverified registration, retry, skip TOTP, sign in, delete', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `passkey-${runId}@example.com`,
		username: `passkey-${runId}`,
		password: 'passkey-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	// Cross from the 127.0.0.1 API origin onto localhost before WebAuthn work so
	// later relative navigations stay on the relying-party domain.
	await gotoLocalhost(page, baseURL, '/account')
	const { client, authenticatorId } = await addVirtualAuthenticator(page)

	// Register a passkey from account settings.
	await gotoLocalhost(page, baseURL, '/account/passkeys')
	await expect(
		page.getByRole('heading', { name: 'No passkeys yet' }),
	).toBeVisible()
	// Fail actual authenticator user verification, without replacing browser or
	// server responses. This is verification failure, not prompt cancellation.
	await client.send('WebAuthn.setUserVerified', {
		authenticatorId,
		isUserVerified: false,
	})
	await page.getByRole('button', { name: 'Register a passkey' }).click()
	await expect(page.getByRole('alert')).toBeVisible()
	await expect(page.getByRole('alert')).not.toHaveText('')
	await expect(
		page.getByRole('button', { name: 'Register a passkey' }),
	).toBeEnabled()
	expect(
		(await client.send('WebAuthn.getCredentials', { authenticatorId }))
			.credentials,
	).toEqual([])
	// Reload proves the server did not retain a credential from the failed attempt.
	await gotoLocalhost(page, baseURL, '/account/passkeys')
	await expect(
		page.getByRole('heading', { name: 'No passkeys yet' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Registered passkeys' }),
	).toHaveCount(0)
	await client.send('WebAuthn.setUserVerified', {
		authenticatorId,
		isUserVerified: true,
	})
	await page.getByRole('button', { name: 'Register a passkey' }).click()
	await expect(page.getByText('Passkey registered.')).toBeVisible()
	expect(
		(await client.send('WebAuthn.getCredentials', { authenticatorId }))
			.credentials,
	).toHaveLength(1)
	await expect(
		page.getByRole('heading', { name: 'Registered passkeys' }),
	).toBeVisible()
	const passkeyList = page.getByRole('list').filter({
		has: page.getByRole('button', { name: 'Rename' }),
	})
	await expect(passkeyList.getByText(/Created /)).toBeVisible()
	await expect(passkeyList.getByText('Last used Never')).toBeVisible()

	// Rename so multiple passkeys stay distinguishable.
	await page.getByRole('button', { name: 'Rename' }).click()
	await page.getByLabel('Passkey nickname').fill('Josh phone')
	await page.getByRole('button', { name: 'Save' }).click()
	await expect(page.getByText('Passkey renamed.')).toBeVisible()
	await expect(passkeyList.getByText('Josh phone')).toBeVisible()

	// Enable 2FA: a verified passkey must still skip the TOTP challenge.
	await gotoLocalhost(page, baseURL, '/account/two-factor')
	await page.getByRole('button', { name: 'Enable 2FA' }).click()
	const secret = (await page.getByTestId('totp-secret').textContent()) ?? ''
	expect(secret.length).toBeGreaterThan(0)
	await page
		.getByLabel('Verification code')
		.fill((await generateTOTP({ secret })).otp)
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(
		page.getByText('Two-factor authentication is enabled.'),
	).toBeVisible()

	// Sign in with the passkey instead of the password; land on /account, not
	// /verify.
	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await gotoLocalhost(page, baseURL, '/login')
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()

	// Delete the passkey.
	await gotoLocalhost(page, baseURL, '/account/passkeys')
	await expect(passkeyList.getByText('Josh phone')).toBeVisible()
	await expect(passkeyList.getByText(/Last used /)).toBeVisible()
	await expect(passkeyList.getByText('Last used Never')).toHaveCount(0)
	await page.getByRole('button', { name: 'Delete' }).click()
	await expect(page.getByText('Passkey deleted.')).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'No passkeys yet' }),
	).toBeVisible()
})

test('expired passkey session reloads identity before opening the authenticator', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	const id = Date.now()
	const user = await seedE2eUser({
		email: `passkey-expired-${id}@example.com`,
		username: `passkey-expired-${id}`,
		password: 'passkey-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await gotoLocalhost(page, baseURL, '/account/passkeys')
	const { client, authenticatorId } = await addVirtualAuthenticator(page)
	await expect(
		page.getByRole('button', { name: 'Register a passkey' }),
	).toBeEnabled()
	// Expire the session without replacing the currently hydrated document.
	await page.context().clearCookies()
	const documentReload = page.waitForRequest((request) =>
		request.isNavigationRequest(),
	)
	await page.getByRole('button', { name: 'Register a passkey' }).click()
	await documentReload
	await expect(page).toHaveURL(/\/login(?:\?|$)/)
	expect(
		(await client.send('WebAuthn.getCredentials', { authenticatorId }))
			.credentials,
	).toEqual([])
	await client.detach()
})

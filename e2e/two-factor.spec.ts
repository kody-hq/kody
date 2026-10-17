import { generateTOTP, verifyTOTP } from '@epic-web/totp'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

async function currentCodeFor(secret: string) {
	const { otp } = await generateTOTP({ secret })
	return otp
}

async function rejectedCodeFor(secret: string) {
	// Exclude every code in a ten-minute window on either side, far beyond this
	// test's deadline, so a time-step rollover cannot make the rejected code valid.
	for (let candidate = 0; candidate < 1_000_000; candidate++) {
		const otp = String(candidate).padStart(6, '0')
		if ((await verifyTOTP({ secret, otp, window: 20 })) === null) return otp
	}
	throw new Error('Could not find an invalid authenticator code')
}

test('two-factor lifecycle rejects invalid codes and recovers on enable, login, and disable', async ({
	page,
	browser,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `two-factor-${runId}@example.com`,
		username: `two-factor-${runId}`,
		password: 'two-factor-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	await page.goto('/account/two-factor')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is disabled',
		}),
	).toBeVisible()
	await page.getByRole('button', { name: 'Enable 2FA' }).click()
	await expect(
		page.getByRole('heading', { name: 'Scan this QR code' }),
	).toBeVisible()

	const secret = (await page.getByTestId('totp-secret').textContent()) ?? ''
	expect(secret.length).toBeGreaterThan(0)

	await page.getByLabel('Verification code').fill(await rejectedCodeFor(secret))
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(page.getByText('Invalid code.', { exact: true })).toBeVisible()
	// The setup secret is intentionally held only by this page, not reloaded
	// through the status endpoint. A rejected code must preserve it for retry.
	await expect(
		page.getByRole('heading', {
			name: 'Scan this QR code',
		}),
	).toBeVisible()
	await expect(page.getByTestId('totp-secret')).toHaveText(secret)

	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(
		page.getByText('Two-factor authentication is enabled.'),
	).toBeVisible()
	await page.reload()
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is enabled',
		}),
	).toBeVisible()

	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	const resume =
		'/oauth/authorize?client_id=redirect-audit&state=state-kept&prompt=login%20consent'
	await page.route('**/oauth/authorize?**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<h1>Authorization resumed</h1>',
		}),
	)
	await page.goto(`/login?redirectTo=${encodeURIComponent(resume)}`)
	await waitForClientHydration(page)
	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password', { exact: true }).fill(user.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/verify\?/)
	expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(resume)
	await waitForClientHydration(page)

	clearAuthRateLimitsInE2eDatabase()
	const verificationUrl = page.url()
	await page.getByLabel('Verification code').fill(await rejectedCodeFor(secret))
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(page.getByText('Invalid code.', { exact: true })).toBeVisible()
	await expect(page).toHaveURL(verificationUrl)
	await page.reload()
	await waitForClientHydration(page)
	await expect(page).toHaveURL(verificationUrl)
	await expect(
		page.getByRole('heading', { name: 'Authorization resumed' }),
	).toHaveCount(0)
	// Keep a pending verification document while another session finishes login.
	const staleContext = await browser.newContext({
		storageState: await page.context().storageState(),
	})
	const staleVerify = await staleContext.newPage()
	await staleVerify.goto(
		new URL('/verify?redirectTo=%2Faccount', page.url()).href,
	)
	await waitForClientHydration(staleVerify)
	await staleVerify
		.getByLabel('Verification code')
		.fill(await currentCodeFor(secret))
	await staleVerify.evaluate(() => {
		document.documentElement.dataset.verificationDocument = 'pending'
	})
	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(
		page.getByRole('heading', { name: 'Authorization resumed' }),
	).toBeVisible()
	const resumed = new URL(page.url())
	expect(resumed.pathname).toBe('/oauth/authorize')
	expect(resumed.searchParams.get('prompt')).toBe('consent')
	expect(resumed.searchParams.get('state')).toBe('state-kept')
	expect(resumed.searchParams.get('client_id')).toBe('redirect-audit')
	try {
		// Install the real successful login cookies without activating/reloading
		// the old document, so the submit itself must handle the identity redirect.
		await staleContext.clearCookies()
		await staleContext.addCookies(await page.context().cookies())
		await staleVerify
			.getByRole('button', { name: 'Verify' })
			.evaluate((button: HTMLButtonElement) => button.click())
		await expect(staleVerify).toHaveURL(/\/account$/)
		await expect(staleVerify.getByText(`Email: ${user.email}`)).toBeVisible()
		await expect(staleVerify.locator('html')).not.toHaveAttribute(
			'data-verification-document',
			'pending',
		)
		await expect(
			staleVerify.getByText('Network error. Please try again.', {
				exact: true,
			}),
		).toHaveCount(0)
	} finally {
		await staleContext.close()
	}
	await page.unroute('**/oauth/authorize?**')
	await page.goto('/account')
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()

	await page.goto('/account/two-factor')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is enabled',
		}),
	).toBeVisible()
	await page.getByLabel('Verification code').fill(await rejectedCodeFor(secret))
	await page.getByRole('button', { name: 'Disable 2FA' }).click()
	await expect(page.getByText('Invalid code.', { exact: true })).toBeVisible()
	await page.reload()
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is enabled',
		}),
	).toBeVisible()
	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Disable 2FA' }).click()
	await expect(
		page.getByText('Two-factor authentication is disabled.'),
	).toBeVisible()

	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto('/login')
	await waitForClientHydration(page)
	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password', { exact: true }).fill(user.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/account$/)
})

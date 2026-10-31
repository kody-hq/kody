import { type BrowserContext, type Page } from '@playwright/test'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test } from './playwright-utils.ts'

/**
 * Package-app visitors on limited browsers (ADR 0094): the sign-in and
 * consent pages work as plain HTML with JavaScript off, and "Sign in on
 * another device" finishes from a second, signed-in browser. The limited
 * browser uses an e-reader's Chromium 80 user agent.
 */
const kindleUserAgent =
	'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36 Kindle/3.0'

/**
 * Inline package-app serving only allowlists plain-http callbacks on
 * `localhost`, so every browser in these tests uses that host.
 */
function localhostBase(baseURL: string | undefined) {
	return baseURL?.replace('://127.0.0.1', '://localhost')
}

async function limitedBrowser(
	browser: import('@playwright/test').Browser,
	baseURL: string | undefined,
) {
	return browser.newContext({
		baseURL: localhostBase(baseURL),
		javaScriptEnabled: false,
		userAgent: kindleUserAgent,
	})
}

function seedApp(ownerEmail: string, ownerUsername: string, kodyId: string) {
	const now = new Date().toISOString()
	executeE2eD1Command(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, is_internet_visible,
			created_at, updated_at
		) VALUES (
			${quoteSqlString(crypto.randomUUID())},
			(SELECT stable_user_id FROM users WHERE email = ${quoteSqlString(ownerEmail)}),
			${quoteSqlString(`@${ownerUsername}/${kodyId}`)},
			${quoteSqlString(kodyId)},
			'Limited browser sign-in E2E',
			'[]',
			NULL,
			${quoteSqlString(crypto.randomUUID())},
			1, 0, 0, 0,
			${quoteSqlString(now)},
			${quoteSqlString(now)}
		)`,
	)
}

function appSignInPath(ownerUsername: string, kodyId: string) {
	const params = new URLSearchParams({
		org: ownerUsername,
		app: kodyId,
		return_to: '/',
	})
	return `/-/auth/login?${params.toString()}`
}

async function expectAppSession(context: BrowserContext) {
	await expect
		.poll(async () =>
			(await context.cookies()).some((cookie) =>
				cookie.name.includes('kody_pkg_session'),
			),
		)
		.toBe(true)
}

async function seedPeople(
	seedE2eUser: (options?: {
		email?: string
		username?: string
		password?: string
	}) => Promise<{ email: string; username: string; password: string }>,
) {
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `limited-owner-${runId}@example.com`,
		username: `limitedowner${runId}`.slice(0, 32),
		password: 'limited-owner-password',
	})
	const visitor = await seedE2eUser({
		email: `limited-visitor-${runId}@example.com`,
		username: `limitedvisitor${runId}`.slice(0, 32),
		password: 'limited-visitor-password',
	})
	const kodyId = `ereader-${runId}`
	seedApp(owner.email, owner.username, kodyId)
	return { owner, visitor, kodyId }
}

async function startDeviceSignIn(page: Page, path: string) {
	await page.goto(path)
	await expect(page).toHaveURL(/\/login\?redirectTo=/)
	await page
		.getByTestId('sign-in-on-another-device')
		.getByRole('button', { name: 'Sign in on another device' })
		.click()
	await expect(page).toHaveURL(/\/oauth\/package-app\/device$/)
	const code = (
		await page.getByTestId('package-app-device-user-code').innerText()
	).trim()
	expect(code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/)
	await expect(page.getByTestId('package-app-device-qr')).toBeVisible()
	return code
}

async function signInPhone(
	context: BrowserContext,
	visitor: { email: string; password: string },
) {
	const response = await context.request.post('/auth', {
		data: { email: visitor.email, password: visitor.password, mode: 'login' },
		headers: { 'Content-Type': 'application/json' },
	})
	expect(response.ok()).toBe(true)
}

test('with JavaScript off, a visitor signs in with email and password and allows the app', async ({
	browser,
	baseURL,
	seedE2eUser,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const { owner, visitor, kodyId } = await seedPeople(seedE2eUser)
	const context = await limitedBrowser(browser, baseURL)
	const page = await context.newPage()
	await page.goto(appSignInPath(owner.username, kodyId))
	await expect(page).toHaveURL(/\/login\?redirectTo=/)
	await expect(page.getByTestId('auth-no-javascript-note')).toBeVisible()

	await page.getByLabel('Email').fill(visitor.email)
	await page.getByLabel('Password', { exact: true }).fill('wrong-password')
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/formError=invalid/)
	await expect(page.getByRole('alert')).toContainText('That did not work.')

	await page.getByLabel('Email').fill(visitor.email)
	await page.getByLabel('Password', { exact: true }).fill(visitor.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page.getByTestId('package-app-oauth-consent')).toBeVisible()
	await page.getByTestId('package-app-oauth-approve').click()
	await expectAppSession(context)
	await context.close()
})

test('a limited browser signs in on another device, and a denial shares nothing', async ({
	browser,
	baseURL,
	seedE2eUser,
}) => {
	test.setTimeout(process.env.CI ? 150_000 : 120_000)
	const { owner, visitor, kodyId } = await seedPeople(seedE2eUser)
	const limited = await limitedBrowser(browser, baseURL)
	const ereader = await limited.newPage()
	const phone = await browser.newContext({ baseURL: localhostBase(baseURL) })
	await signInPhone(phone, visitor)
	const phonePage = await phone.newPage()

	// Deny first: the e-reader is told, and gets no session.
	const deniedCode = await startDeviceSignIn(
		ereader,
		appSignInPath(owner.username, kodyId),
	)
	await phonePage.goto(`/device?user_code=${deniedCode}`)
	await expect(phonePage.getByTestId('package-app-oauth-device')).toContainText(
		'Kindle browser (Chrome 80)',
	)
	await expect(
		phonePage.getByTestId('package-app-oauth-device-code'),
	).toHaveText(deniedCode)
	await phonePage.getByTestId('package-app-oauth-deny').click()
	await expect(phonePage).toHaveURL(/\/device\?result=denied/)
	await ereader.getByTestId('package-app-device-check-now').click()
	await expect(
		ereader.getByRole('heading', { name: 'Sign-in was denied' }),
	).toBeVisible()
	expect(
		(await limited.cookies()).some((cookie) =>
			cookie.name.includes('kody_pkg_session'),
		),
	).toBe(false)

	// Then approve: the e-reader continues to the app on its next check.
	const code = await startDeviceSignIn(
		ereader,
		appSignInPath(owner.username, kodyId),
	)
	await phonePage.goto(`/device?user_code=${code}`)
	await phonePage.getByTestId('package-app-oauth-approve').click()
	await expect(phonePage).toHaveURL(/\/device\?result=approved/)
	await expect(
		phonePage.getByRole('heading', { name: 'Device approved' }),
	).toBeVisible()
	await ereader.getByTestId('package-app-device-check-now').click()
	await expectAppSession(limited)

	// The code is single use: checking again finds nothing in progress.
	await ereader.goto('/oauth/package-app/device')
	await expect(
		ereader.getByRole('heading', { name: 'No sign-in in progress' }),
	).toBeVisible()
	await limited.close()
	await phone.close()
})

test('a limited browser with JavaScript on gets the plain sign-in page, with no app bundle', async ({
	browser,
	baseURL,
	seedE2eUser,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const { owner, kodyId } = await seedPeople(seedE2eUser)
	const context = await browser.newContext({
		baseURL: localhostBase(baseURL),
		userAgent: kindleUserAgent,
	})
	const page = await context.newPage()
	await page.goto(appSignInPath(owner.username, kodyId))
	await expect(page).toHaveURL(/\/login\?.*plain=1/)
	await expect(page.locator('script[type="module"]')).toHaveCount(0)
	await expect(
		page
			.getByTestId('sign-in-on-another-device')
			.getByRole('button', { name: 'Sign in on another device' }),
	).toBeVisible()
	await context.close()
})

test("with JavaScript off, a package app's Open link offers Sign in on another device and lands in the app", async ({
	browser,
	baseURL,
	seedE2eUser,
}) => {
	test.setTimeout(process.env.CI ? 150_000 : 120_000)
	const { owner, visitor, kodyId } = await seedPeople(seedE2eUser)
	const limited = await limitedBrowser(browser, baseURL)
	const ereader = await limited.newPage()
	const phone = await browser.newContext({ baseURL: localhostBase(baseURL) })
	await signInPhone(phone, visitor)
	const phonePage = await phone.newPage()

	await ereader.goto(`/@${owner.username}/packages/${kodyId}/open`)
	await expect(ereader).toHaveURL(/\/login\?/)
	await expect(ereader.getByTestId('auth-no-javascript-note')).toContainText(
		'Sign in on another device',
	)
	await ereader
		.getByTestId('sign-in-on-another-device')
		.getByRole('button', { name: 'Sign in on another device' })
		.click()
	await expect(ereader).toHaveURL(/\/oauth\/package-app\/device$/)
	const code = (
		await ereader.getByTestId('package-app-device-user-code').innerText()
	).trim()
	expect(code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/)

	await phonePage.goto(`/device?user_code=${code}`)
	await phonePage.getByTestId('package-app-oauth-approve').click()
	await expect(phonePage).toHaveURL(/\/device\?result=approved/)
	await ereader.getByTestId('package-app-device-check-now').click()
	await expectAppSession(limited)
	await expect(ereader).toHaveURL(
		// Back on the app's path (local serving may show its package page).
		new RegExp(`/@${owner.username}/(?:packages/)?${kodyId}(?:[/?]|$)`),
	)
	await limited.close()
	await phone.close()
})

test('Kody pages that are not a package app never mention another device', async ({
	browser,
	baseURL,
}) => {
	const context = await limitedBrowser(browser, baseURL)
	const page = await context.newPage()
	await page.goto('/login?redirectTo=%2Faccount&formError=human_check')
	await expect(page.getByTestId('sign-in-on-another-device')).toHaveCount(0)
	await expect(page.getByRole('alert')).not.toContainText('another device')
	await expect(page.getByTestId('auth-no-javascript-note')).not.toContainText(
		'another device',
	)
	await context.close()
})

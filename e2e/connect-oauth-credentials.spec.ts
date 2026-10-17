import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

/**
 * KODY-8K: many same-turn `input` events on controlled credential fields each
 * called `handle.update()`, and Remix's cascade guard threw after 51 updates
 * (`ConnectOauthRoute x51`, minified as `hr` in production). Credential drafts
 * do not need a re-render per keystroke; this pins that rapid sequential insert
 * (autofill / paste / delay-0 typing) stays under the guard.
 */
test('connect oauth credential typing does not trip the update cascade guard', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 60_000 : 45_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `connect-oauth-${runId}@example.com`,
		username: `connect-oauth-${runId}`,
		password: 'connect-oauth-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const cascadeLogs: Array<string> = []
	page.on('console', (msg) => {
		const text = msg.text()
		if (/infinite loop|cascading component updates/i.test(text)) {
			cascadeLogs.push(text)
		}
	})
	page.on('pageerror', (error) => {
		const text = String(error)
		if (/infinite loop|cascading component updates/i.test(text)) {
			cascadeLogs.push(text)
		}
	})

	const setupUrl =
		'/connect/oauth?provider=notion-test&authorizeUrl=' +
		encodeURIComponent('https://api.notion.com/v1/oauth/authorize') +
		'&tokenUrl=' +
		encodeURIComponent('https://api.notion.com/v1/oauth/token') +
		'&flow=confidential&scopes=&allowedHosts=api.notion.com'

	await page.goto(setupUrl)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Enter your app credentials' }),
	).toBeVisible()

	const clientId = page.locator('input[name="oauthClientId"]')
	await clientId.click()
	// delay: 0 packs many input events into one event-loop turn — the same
	// class of burst as password-manager autofill that tripped KODY-8K.
	await clientId.pressSequentially('a'.repeat(60), { delay: 0 })
	await expect(clientId).toHaveValue('a'.repeat(60))

	const clientSecret = page.locator('input[name="oauthClientSecret"]')
	await clientSecret.click()
	await clientSecret.pressSequentially('secret-value-here-12345', {
		delay: 0,
	})
	await expect(clientSecret).toHaveValue('secret-value-here-12345')

	expect(cascadeLogs, cascadeLogs.join('\n')).toEqual([])
})

for (const callback of [
	{
		search:
			'error=access_denied&error_description=Provider%20declined%20the%20request',
		message: 'Provider declined the request',
	},
	{
		search: 'code=unused-code&state=untrusted-state',
		message: 'State mismatch. Restart the OAuth flow.',
	},
]) {
	test(`OAuth callback survives native URL cleanup: ${callback.message}`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const id = crypto.randomUUID().slice(0, 8)
		const user = await seedE2eUser({
			email: `callback-${id}@example.com`,
			username: `callback-${id}`,
		})
		await login({ ...user, mode: 'login' })
		const configuration = new URLSearchParams({
			provider: 'notion-test',
			authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			flow: 'confidential',
			allowedHosts: 'api.notion.com',
		})
		await page.goto(`/connect/oauth?${configuration}&${callback.search}`)
		await waitForClientHydration(page)
		await expect(page).toHaveURL(/\/connect\/oauth$/)
		// Remounting on replacement would discard the captured callback/configuration
		// and show the chooser instead of the provider or state-validation error.
		await expect(
			page.getByText(callback.message, { exact: true }),
		).toBeVisible()
	})
}

// Only the provider's authorization page is simulated in the browser. The
// callback, Start server functions, HTTP token exchange, storage and credential listing
// all run through the app and the existing mock worker.
test('OAuth callback exchanges and persists a connection with its required hosts', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = crypto.randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `oauth-success-${id}@example.com`,
		username: `oauth-success-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const mock = readE2eCloudflareMockState()
	const provider = `rehearsal-${id}`
	const authorizeUrl = `${mock.origin}/__mocks/rehearsal/oauth/authorize`
	let authorizations = 0
	await page.route(`${authorizeUrl}?**`, async (route) => {
		const authorization = new URL(route.request().url())
		expect(authorization.searchParams.get('response_type')).toBe('code')
		expect(authorization.searchParams.get('client_id')).toBe('rehearsal-client')
		const state = authorization.searchParams.get('state')
		expect(state).toBeTruthy()
		const callback = new URL(authorization.searchParams.get('redirect_uri')!)
		expect(callback.origin).toBe(
			new URL(test.info().project.use.baseURL!).origin,
		)
		expect(callback.pathname).toBe('/connect/oauth')
		callback.searchParams.set('code', `rehearsal-code-${id}`)
		callback.searchParams.set('state', state!)
		authorizations += 1
		await route.fulfill({ status: 302, headers: { location: callback.href } })
	})
	const configuration = new URLSearchParams({
		provider,
		authorizeUrl,
		tokenUrl: `${mock.origin}/__mocks/rehearsal/oauth/token`,
		flow: 'confidential',
		allowedHosts: new URL(mock.origin).hostname,
	})
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	await page.locator('input[name="oauthClientId"]').fill('rehearsal-client')
	await page.locator('input[name="oauthClientSecret"]').fill('rehearsal-secret')
	await page.getByRole('button', { name: 'Save and continue' }).click()
	await page.getByRole('button', { name: `Continue to ${provider}` }).click()
	await expect(
		page.getByText("You're connected.", { exact: true }),
	).toBeVisible()
	const details = page.getByTestId('connect-oauth-advanced')
	await details.getByText('Advanced details', { exact: true }).click()
	await expect(
		details.getByText('Access token saved', { exact: true }),
	).toBeVisible()
	await expect(
		details.getByText('Refresh token saved', { exact: true }),
	).toBeVisible()
	await expect(details.getByText('Yes', { exact: true })).toHaveCount(2)
	await expect(page).toHaveURL(/\/connect\/oauth$/)
	expect(authorizations).toBe(1)

	// A fresh document must read the persisted connection, rather than merely
	// retaining the callback component's success state.
	await page.goto(`/@${user.username}/-/credentials?kind=oauth`)
	const credentialLink = page
		.getByRole('region', { name: 'Credentials', exact: true })
		.getByRole('link', { name: new RegExp(provider) })
	const row = page
		.getByRole('region', { name: 'Credentials', exact: true })
		.getByRole('row')
		.filter({ hasText: provider })
	await expect(row).toContainText(new URL(mock.origin).hostname)
	await credentialLink.click()
	await expect(
		page.getByRole('heading', { name: provider, exact: true }),
	).toBeVisible()
	await page.reload()
	await expect(
		page.getByRole('heading', { name: provider, exact: true }),
	).toBeVisible()
	await expect(
		page.getByText(
			'An OAuth connection. Kody keeps its token fresh and places it on requests to the provider’s hosts.',
			{ exact: true },
		),
	).toBeVisible()
})

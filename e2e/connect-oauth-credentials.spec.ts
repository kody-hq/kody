import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

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

test('connect page names the destination org and asks multi-org users to pick one', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const id = crypto.randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `oauth-org-${id}@example.com`,
		username: `oauth-org-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const mock = readE2eCloudflareMockState()
	const provider = `rehearsal-${id}`
	const authorizeUrl = `${mock.origin}/__mocks/rehearsal/oauth/authorize`
	await page.route(`${authorizeUrl}?**`, async (route) => {
		const authorization = new URL(route.request().url())
		const callback = new URL(authorization.searchParams.get('redirect_uri')!)
		callback.searchParams.set('code', `rehearsal-code-${id}`)
		callback.searchParams.set('state', authorization.searchParams.get('state')!)
		await route.fulfill({ status: 302, headers: { location: callback.href } })
	})
	const configuration = new URLSearchParams({
		provider,
		authorizeUrl,
		tokenUrl: `${mock.origin}/__mocks/rehearsal/oauth/token`,
		flow: 'confidential',
		allowedHosts: new URL(mock.origin).hostname,
	})

	// Single org: no picker, just the label.
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('connect-oauth-org-picker')).toHaveCount(0)
	await expect(page.getByTestId('connect-oauth-org-target')).toContainText(
		'personal organization',
	)
	await expect(page.locator('input[name="oauthClientId"]')).toBeVisible()

	const team = `oauth-team-${id}`
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`OAuth Team ${id}`)
	await page.getByLabel('Handle').fill(team)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@${team}/-/overview$`))

	// Multi-org, no org param: picker first (personal default), no setup form.
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	const select = page.getByTestId('connect-oauth-org-select')
	await expect(select).toHaveValue(user.username)
	await expect(page.locator('input[name="oauthClientId"]')).toHaveCount(0)
	await select.selectOption(team)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`[?&]org=${team}(&|$)`))
	await expect(new URL(page.url()).searchParams.get('provider')).toBe(provider)

	// Explicit org: label only; the callback keeps the chosen org.
	await waitForClientHydration(page)
	await expect(page.getByTestId('connect-oauth-org-picker')).toHaveCount(0)
	await expect(page.getByTestId('connect-oauth-org-target')).toContainText(
		`@${team}`,
	)
	await page.locator('input[name="oauthClientId"]').fill('rehearsal-client')
	await page.locator('input[name="oauthClientSecret"]').fill('rehearsal-secret')
	await page.getByRole('button', { name: 'Save and continue' }).click()
	await page.getByRole('button', { name: `Continue to ${provider}` }).click()
	await expect(
		page.getByText("You're connected.", { exact: true }),
	).toBeVisible()
	await expect(page.getByTestId('connect-oauth-org-target')).toContainText(
		`@${team}`,
	)

	await page.goto(`/@${team}/-/credentials?kind=oauth`)
	await expect(
		page
			.getByRole('region', { name: 'Credentials', exact: true })
			.getByRole('link', { name: new RegExp(provider) }),
	).toBeVisible()
	await page.goto(`/@${user.username}/-/credentials?kind=oauth`)
	await waitForClientHydration(page)
	await expect(
		page
			.getByRole('region', { name: 'Credentials', exact: true })
			.getByRole('link', { name: new RegExp(provider) }),
	).toHaveCount(0)
})

import { saveKeyThroughUi } from './account-fixtures.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('Credentials lists a key, filters by kind, and opens its detail pane without the value', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `credentials-${runId}@example.com`,
		username: `credentials-${runId}`,
		password: 'credentials-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `sk-never-shown-${runId}`
	await saveKeyThroughUi(page, {
		name: 'DEMO_API_KEY',
		value,
		description: 'Demo key',
		allowedHosts: ['api.example.com'],
	})

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const table = page.getByRole('region', { name: 'Credentials', exact: true })
	const row = table.getByRole('link', { name: /DEMO_API_KEY/ })
	await expect(row).toBeVisible()
	const addCredential = page.getByRole('link', { name: 'Add credential' })
	await expect(addCredential).toHaveAttribute(
		'href',
		`/@${user.username}/-/credentials/new`,
	)
	await expect(
		addCredential
			.locator('xpath=..')
			.getByRole('link', { name: 'Secret providers' }),
	).toHaveAttribute('href', `/@${user.username}/-/secret-providers`)
	await expect(
		page.getByRole('link', { name: 'How credentials work' }),
	).toHaveAttribute('href', '/docs/credentials')

	// A filter changes only the displayed rows. Keep the same mounted table and
	// do not invoke either a page loader or the session verifier.
	const requests: string[] = []
	const collectRequest = (request: { url(): string }) => {
		if (request.url().includes('/_serverFn/')) requests.push(request.url())
	}
	page.on('request', collectRequest)
	await table.evaluate((element) =>
		element.setAttribute('data-filter-mount', 'same'),
	)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.fill('OAuth')
	// Repositioning the caret must keep the filtered option list intact.
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.click()
	await expect(
		page.getByRole('option', { name: 'Key', exact: true }),
	).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.press('Enter')
	await expect(page).toHaveURL(/\/credentials\?kind=oauth$/)
	await expect(row).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.fill('Key')
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.press('Enter')
	await expect(row).toBeVisible()
	// Do not wait for the search navigation before changing another filter.
	await page
		.getByLabel('Search credentials', { exact: true })
		.pressSequentially('DEMO')
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.fill('OAuth')
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.press('Enter')
	await expect(page).toHaveURL(
		(url) =>
			url.searchParams.get('q') === 'DEMO' &&
			url.searchParams.get('kind') === 'oauth',
	)
	await expect(row).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.fill('Key')
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.press('Enter')
	await expect(row).toBeVisible()
	await page.getByLabel('Search credentials', { exact: true }).fill('')
	await expect(page).toHaveURL(/\/credentials\?kind=secret$/)
	await expect(table).toHaveAttribute('data-filter-mount', 'same')
	page.off('request', collectRequest)
	expect(requests).toEqual([])

	await row.click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/credentials/[^/?]+\\?kind=secret$`),
	)
	const pane = page.getByRole('region', { name: 'DEMO_API_KEY details' })
	await expect(pane.getByText('{{secret:DEMO_API_KEY}}')).toBeVisible()
	await expect(pane.getByText('api.example.com')).toBeVisible()
	await expect(pane.getByText('Authorization: Bearer {value}')).toBeVisible()
	await expect(pane.getByRole('link', { name: 'Edit' })).toHaveAttribute(
		'href',
		`/@${user.username}/-/secrets/user/DEMO_API_KEY`,
	)
	await expect(page.getByText(value)).toHaveCount(0)

	// The open row collapses back to the list, keeping the filter.
	await row.click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/credentials\\?kind=secret$`),
	)
	await expect(pane).toHaveCount(0)

	// The indexes Credentials folds together redirect to it, filtered.
	for (const [section, landing] of [
		['secrets', '/credentials?kind=secret'],
		['integrations', '/credentials?kind=oauth'],
		['mcp-servers', '/credentials?kind=mcp'],
		['secret-providers', '/secret-providers'],
	] as const) {
		const response = await page.goto(`/@${user.username}/-/${section}`)
		expect(response?.status(), section).toBe(200)
		expect(page.url(), section).toMatch(
			new RegExp(`/@${user.username}/-${landing.replace('?', '\\?')}$`),
		)
	}

	await page.goto(`/@${user.username}/-/credentials/does-not-exist`)
	await waitForClientHydration(page)
	await expect(
		page
			.getByTestId('credentials-error')
			.getByRole('button', { name: 'Copy prompt for your agent' }),
	).toBeVisible()
})

test('the creation link saves Key, URL, and login credentials from their prefill', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `credential-link-${runId}@example.com`,
		username: `credential-link-${runId}`,
		password: 'credential-link-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `re-never-shown-${runId}`

	await page.goto(
		'/connect/credential?kind=secret&kindMode=required&name=DIGEST_KEY&provider=resend&allowedHosts=api.resend.com&forPackage=pr-digest&need=email',
	)
	await waitForClientHydration(page)
	// The org-less link opens the signup org's creation page, query intact.
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=secret&kindMode=required&name=DIGEST_KEY&`,
		),
	)
	await expect(page.getByRole('heading', { name: 'Add a key' })).toBeVisible()
	await expect(
		page.getByText('This link asks for a Key credential.'),
	).toBeVisible()
	await expect(page.getByTestId('credential-kind-oauth')).toHaveCount(0)
	await expect(page.getByLabel('Name')).toHaveValue('DIGEST_KEY')
	await expect(page.getByLabel(/Allowed hosts/)).toHaveValue('api.resend.com')
	await page.getByRole('textbox', { name: 'Value' }).fill(value)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'DIGEST_KEY is saved',
	)
	await expect(page.getByText(value)).toHaveCount(0)
	await expect
		.poll(async () => {
			const href = await page
				.getByTestId('connect-credential-approve')
				.getAttribute('href')
			if (!href) return null
			const url = new URL(href, page.url())
			return {
				origin: url.origin,
				pathname: url.pathname,
				params: [...url.searchParams],
			}
		})
		.toEqual({
			origin: new URL(page.url()).origin,
			pathname: `/@${user.username}/pr-digest/approve-credentials`,
			params: [['mine[email]', expect.stringMatching(/^id:[^&]+$/)]],
		})

	await page.getByRole('link', { name: 'View credential' }).click()
	const pane = page.getByRole('region', { name: 'DIGEST_KEY details' })
	await expect(pane.getByText('api.resend.com')).toBeVisible()
	await expect(pane.getByText('resend', { exact: true })).toBeVisible()

	// A hinted kind can change; OAuth hands the prefill to /connect/oauth.
	await page.goto('/connect/credential?kind=secret&provider=github')
	await waitForClientHydration(page)
	await page.getByTestId('credential-kind-oauth').click()
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=oauth&provider=github$`,
		),
	)
	await expect(page.getByTestId('connect-credential-continue')).toHaveAttribute(
		'href',
		`/connect/oauth?kind=oauth&provider=github&org=${user.username}`,
	)

	// A URL credential takes its hosts; a value off those hosts is refused
	// with a prompt the person can hand their agent.
	await page.goto(
		'/connect/credential?kind=url&kindMode=required&name=BOT_URL&allowedHosts=api.telegram.org',
	)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Add a URL credential' }),
	).toBeVisible()
	await expect(page.getByLabel(/^Hosts/)).toHaveValue('api.telegram.org')
	const urlValue = `https://api.telegram.org/bot${runId}:never-shown/sendMessage`
	await page
		.getByRole('textbox', { name: 'Value' })
		.fill('https://hooks.example.com/elsewhere')
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-message')).toContainText(
		'must be one of its hosts',
	)
	await expect(
		page.getByRole('button', { name: 'Copy prompt for your agent' }),
	).toBeVisible()
	await page.getByRole('textbox', { name: 'Value' }).fill(urlValue)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'BOT_URL is saved',
	)
	await page.getByRole('link', { name: 'View credential' }).click()
	const urlPane = page.getByRole('region', { name: 'BOT_URL details' })
	await expect(urlPane.getByText('api.telegram.org')).toBeVisible()
	await expect(page.getByText(urlValue)).toHaveCount(0)

	// A login link carries its exchange, so the person types only the fields
	// the exchange body names.
	const exchange = {
		url: 'https://api.example.com/session',
		bodyFormat: 'json',
		body: { email: '{email}', password: '{password}' },
		tokenPath: 'data.token',
	}
	await page.goto(
		`/connect/credential?kind=login&name=SITE_LOGIN&allowedHosts=api.example.com&loginExchange=${encodeURIComponent(JSON.stringify(exchange))}`,
	)
	await waitForClientHydration(page)
	await expect(
		page.getByTestId('connect-credential-login-exchange'),
	).toContainText('api.example.com')
	await page.getByLabel('Email').fill('me@example.com')
	await page.getByRole('textbox', { name: 'Password' }).fill(`pw-${runId}`)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'SITE_LOGIN is saved',
	)
})

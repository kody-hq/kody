import { saveKeyThroughUi } from './account-fixtures.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from './playwright-utils.ts'

async function accountRailStickyTop(page: Page) {
	await page.evaluate(() => window.scrollTo(0, 0))
	const rail = page.locator('[data-account-nav] > div').first()
	await expect(rail).toBeVisible()
	return rail.evaluate((element) => element.getBoundingClientRect().top)
}

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
		.selectOption('oauth')
	await expect(page).toHaveURL(/\/credentials\?kind=oauth$/)
	await expect(row).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.selectOption('secret')
	await expect(row).toBeVisible()
	// Do not wait for the search navigation before changing another filter.
	await page
		.getByLabel('Search credentials', { exact: true })
		.pressSequentially('DEMO')
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.selectOption('oauth')
	await expect(page).toHaveURL(
		(url) =>
			url.searchParams.get('q') === 'DEMO' &&
			url.searchParams.get('kind') === 'oauth',
	)
	await expect(row).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.selectOption('secret')
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

test('a Key detail pane edits its allowed hosts, HTTPS host names only', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `credential-hosts-${runId}@example.com`,
		username: `credential-hosts-${runId}`,
		password: 'credential-hosts-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `sk-hosts-never-shown-${runId}`
	await saveKeyThroughUi(page, {
		name: 'HOSTS_KEY',
		value,
		allowedHosts: ['api.example.com'],
	})

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	await page
		.getByRole('region', { name: 'Credentials', exact: true })
		.getByRole('link', { name: /HOSTS_KEY/ })
		.click()
	const pane = page.getByRole('region', { name: 'HOSTS_KEY details' })
	await pane.getByTestId('credential-hosts-edit').click()
	const editor = pane.getByTestId('credential-hosts-editor')
	const input = editor.getByRole('textbox', { name: 'Host to allow' })

	await input.fill('http://plain.example.com')
	await editor.getByRole('button', { name: 'Add host' }).click()
	await expect(editor.getByRole('alert')).toHaveText(
		'Kody sends credentials only over HTTPS. Enter the host without http://.',
	)

	await input.fill('https://Uploads.Example.com/')
	await editor.getByRole('button', { name: 'Add host' }).click()
	await expect(input).toHaveValue('')
	await expect(editor.getByText('uploads.example.com')).toBeVisible()

	// The server is the authority on what a host name is.
	await input.fill('*.example.com')
	await editor.getByTestId('credential-hosts-save').click()
	await expect(editor.getByRole('alert')).toContainText(
		'wildcards are not supported',
	)
	await input.fill('')

	await editor.getByRole('button', { name: 'Remove api.example.com' }).click()
	await editor.getByTestId('credential-hosts-save').click()
	await expect(
		pane.getByRole('status').filter({ hasText: 'Hosts saved.' }),
	).toBeVisible()
	await expect(pane.getByText('uploads.example.com')).toBeVisible()
	await expect(pane.getByText('api.example.com')).toHaveCount(0)
	await expect(page.getByText(value)).toHaveCount(0)

	// Reopening right after a save starts from what was saved.
	await pane.getByTestId('credential-hosts-edit').click()
	await expect(
		editor.getByRole('button', { name: 'Remove uploads.example.com' }),
	).toBeVisible()
	await expect(
		editor.getByRole('button', { name: 'Remove api.example.com' }),
	).toHaveCount(0)
	await editor.getByRole('button', { name: 'Cancel' }).click()

	// A fresh document must read the saved hosts, independently of the Query cache.
	await page.reload()
	await waitForClientHydration(page)
	await expect(pane.getByText('uploads.example.com')).toBeVisible()
	await expect(pane.getByText('api.example.com')).toHaveCount(0)
	await expect(page.getByText(value)).toHaveCount(0)
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

test('the legacy secret intake link opens the Key form with its prefill', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `secret-set-${runId}@example.com`,
		username: `secret-set-${runId}`,
		password: 'secret-set-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	await page.goto(
		'/connect/secret-set?name=STRIPE_KEY&description=Billing&allowed-host=api.stripe.com&package=pkg-gone&expiresAt=2030-01-31',
	)
	await waitForClientHydration(page)
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=secret&name=STRIPE_KEY&`,
		),
	)
	await expect(page.getByRole('heading', { name: 'Add a key' })).toBeVisible()
	await expect(page.getByLabel('Name')).toHaveValue('STRIPE_KEY')
	await expect(page.getByLabel(/^Description/)).toHaveValue('Billing')
	await expect(page.getByLabel(/Allowed hosts/)).toHaveValue('api.stripe.com')
	await expect(page.getByLabel(/^Expires/)).toHaveValue('2030-01-31')
	const access = page.getByTestId('connect-credential-package-access')
	await expect(access).toContainText('pkg-gone')
	await expect(access).toContainText('(not found in this org)')
	await expect(access.getByRole('checkbox')).toBeChecked()

	// A package key for a package this org does not have cannot be saved.
	await page.goto(
		'/connect/secret-set?name=STRIPE_KEY&scope=package&packageId=pkg-gone',
	)
	await waitForClientHydration(page)
	await expect(page.getByTestId('connect-credential-link-problem')).toHaveText(
		'This link names a package that is not in this org.',
	)
	await expect(page.getByTestId('connect-credential-save')).toBeDisabled()

	// Org-less pages link back here; it opens the signup org's list.
	await page.goto('/account/credentials?kind=secret')
	await waitForClientHydration(page)
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/credentials\\?kind=secret$`),
	)
})

test('case-only credential rename persists on the secrets editor', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `cred-case-rename-${runId}@example.com`,
		username: `credcaserename${runId}`,
		password: 'cred-case-rename-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto(
		'/connect/credential?kind=url&kindMode=required&name=Henry&allowedHosts=hooks.example.com',
	)
	await waitForClientHydration(page)
	await page
		.getByRole('textbox', { name: 'Value', exact: true })
		.fill('https://hooks.example.com/henry')
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'Henry is saved',
	)

	await page.goto(`/@${user.username}/-/secrets/user/Henry`)
	await waitForClientHydration(page)
	const nameInput = page.locator('input[placeholder="api-token"]')
	await expect(nameInput).toHaveValue('Henry')
	await nameInput.fill('henry')
	await page.getByRole('button', { name: 'Save' }).click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/secrets/user/henry`),
	)
	await expect(nameInput).toHaveValue('henry')
	await expect(
		page.getByRole('link', { name: 'henry', exact: true }),
	).toBeVisible()

	// A fresh document proves the stored name and kind, independent of the editor cache.
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const table = page.getByRole('region', { name: 'Credentials', exact: true })
	const renamed = table.getByRole('link', { name: /^henry(?:\s|$)/ })
	await expect(renamed).toBeVisible()
	await expect(renamed.locator('xpath=ancestor::tr')).toContainText('URL')
	await expect(table.getByRole('link', { name: /^Henry(?:\s|$)/ })).toHaveCount(
		0,
	)
	await page.goto(`/@${user.username}/-/secrets/user/henry`)
	await waitForClientHydration(page)
	await expect(nameInput).toHaveValue('henry')
})

test('account rail top stays put when credentials search shrinks a tall list', async ({
	page,
	seedE2eUser,
	login,
}) => {
	// Enough rows that the content column outgrows the sticky rail (so sticky
	// engages on the full list) plus one uniquely searchable name.
	test.setTimeout(process.env.CI ? 180_000 : 120_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `cred-rail-${runId}@example.com`,
		username: `cred-rail-${runId}`,
		password: 'cred-rail-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const searchable = `AUDIBLE_RAIL_${runId}`
	const names = [
		searchable,
		...Array.from({ length: 17 }, (_, i) => `RAIL_FILL_${runId}_${i}`),
	]
	const context = page.context()
	await Promise.all(
		names.map(async (name, index) => {
			const tab = await context.newPage()
			try {
				await saveKeyThroughUi(tab, {
					name,
					value: `sk-rail-${runId}-${index}`,
					allowedHosts: ['api.example.com'],
				})
			} finally {
				await tab.close()
			}
		}),
	)

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const table = page.getByRole('region', { name: 'Credentials', exact: true })
	await expect(table.getByText(/\d+ of \d+/)).toContainText(
		`${names.length} of ${names.length}`,
	)
	const longTop = await accountRailStickyTop(page)
	const longNavHeight = await page
		.locator('[data-account-nav]')
		.evaluate((element) => element.getBoundingClientRect().height)
	const longRailHeight = await page
		.locator('[data-account-nav] > div')
		.first()
		.evaluate((element) => element.getBoundingClientRect().height)
	expect(
		longNavHeight,
		'full list must stretch the nav taller than the rail so sticky engages',
	).toBeGreaterThan(longRailHeight + 1)

	await page.getByLabel('Search credentials', { exact: true }).fill('AUDIBLE')
	await expect(page).toHaveURL(/[?&]q=AUDIBLE/)
	await expect(
		table.getByRole('link', { name: new RegExp(searchable) }),
	).toBeVisible()
	await expect(table.getByText(/of \d+/)).toContainText(`1 of ${names.length}`)
	const shortTop = await accountRailStickyTop(page)
	const shortNavHeight = await page
		.locator('[data-account-nav]')
		.evaluate((element) => element.getBoundingClientRect().height)
	expect(
		shortNavHeight,
		'filtered list should leave the nav about as tall as the rail',
	).toBeLessThanOrEqual(longRailHeight + 1)

	expect(Math.abs(shortTop - longTop)).toBeLessThanOrEqual(0.5)
})

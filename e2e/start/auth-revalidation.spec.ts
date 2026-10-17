import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('expired admin session redirects during revalidation without a render error', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `expired-${id}@example.com`,
		username: `expired-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/admin/feature-flags')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text())
	})
	const refreshed = page.waitForResponse(
		async (response) =>
			response.request().headers()['x-tsr-serverfn'] !== undefined &&
			(await response.text()).includes('forbidden'),
	)
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	const authenticated = await refreshed
	expect(authenticated.ok()).toBe(true)
	await page.waitForLoadState('networkidle')
	await page.context().clearCookies()
	// A bound browser first resets its document. The resulting document request
	// and unbound RPC callers still go through the handler's login redirect.
	const rpcHeaders = await authenticated.request().allHeaders()
	delete rpcHeaders.cookie
	const mismatched = await page.request.get(authenticated.url(), {
		headers: rpcHeaders,
	})
	const reset = await mismatched.json()
	expect(reset.isSerializedRedirect).toBe(true)
	expect(reset.reloadDocument).toBe(true)
	expect(new URL(reset.href, page.url()).pathname).toBe('/admin/feature-flags')
	delete rpcHeaders['x-kody-document-actor']
	delete rpcHeaders['x-kody-document-destination']
	// Absolute handler redirects previously constructed a router outside the
	// request middleware's ALS scope. Keep checking that direct RPC contract.
	const signedOut = await page.request.get(authenticated.url(), {
		headers: rpcHeaders,
	})
	expect(signedOut.status(), await signedOut.text()).toBe(200)
	const redirect = await signedOut.json()
	expect(redirect.isSerializedRedirect).toBe(true)
	expect(new URL(redirect.href, page.url()).pathname).toBe('/login')
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	await expect(page).toHaveURL(/\/login\?/)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toHaveCount(0)
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	expect(errors).toEqual([])
})

test('overlapping SSR documents retain distinct matching request nonces', async ({
	request,
}) => {
	const responses = await Promise.all(
		['/pricing', '/faq'].map((path) => request.get(path)),
	)
	const nonces = []
	for (const response of responses) {
		expect(response.status()).toBe(200)
		const csp = response.headers()['content-security-policy']
		const nonce = csp?.match(/'nonce-([^']+)'/)?.[1]
		expect(nonce).toBeTruthy()
		nonces.push(nonce)
		const html = await response.text()
		const scriptNonces = [
			...html.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/g),
		].map((match) => match[1])
		expect(scriptNonces.length).toBeGreaterThan(0)
		expect(scriptNonces.every((value) => value === nonce)).toBe(true)
	}
	expect(nonces[0]).not.toBe(nonces[1])
})

test('revoking the same user admin role blocks a warm cached revisit', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `role-a-${id}@example.com`,
		username: `role-a-${id}`,
		admin: true,
	})
	const operator = await seedE2eUser({
		email: `role-b-${id}@example.com`,
		username: `role-b-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/admin/feature-flags')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	await page.evaluate(() => {
		document.documentElement.dataset.permissionDocument = 'original'
		window.history.pushState(null, '', '/account')
	})
	await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'View public profile', exact: true }),
	).toHaveAttribute('href', `/@${user.username}`)
	const other = await browser.newContext({ baseURL })
	try {
		const signedIn = await other.request.post('/auth', {
			data: { ...operator, mode: 'login' },
		})
		expect(signedIn.ok()).toBe(true)
		const operatorPage = await other.newPage()
		await operatorPage.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
		await waitForClientHydration(operatorPage)
		await operatorPage
			.getByRole('row')
			.filter({ hasText: user.email })
			.getByRole('link')
			.first()
			.click()
		await operatorPage
			.getByRole('combobox', { name: 'Role', exact: true })
			.selectOption('admin')
		await expect(
			operatorPage.getByRole('combobox', { name: 'Role', exact: true }),
		).toHaveValue('admin')
		const roleChangeResponse = operatorPage.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.startsWith('/_serverFn/') &&
				response.request().method() === 'POST' &&
				response.request().postData()?.includes('stableUserId') === true &&
				response.request().postData()?.includes('admin') === true,
		)
		await operatorPage
			.getByRole('button', { name: 'Remove', exact: true })
			.click()
		const changed = await roleChangeResponse
		const changeResult = await changed.text()
		expect(changed.status(), changeResult).toBe(200)
		expect(changeResult).toContain('updatedUser')
		await expect
			.poll(async () => operatorPage.locator('main').innerText())
			.toContain('Removed admin role.')
		await page.evaluate(() =>
			window.history.pushState(null, '', '/admin/feature-flags'),
		)
		await expect(page.getByText('Forbidden', { exact: true })).toBeVisible()
		await expect(
			page.getByRole('heading', { name: 'Admin feature flags' }),
		).toHaveCount(0)
		await expect(page.locator('html')).toHaveAttribute(
			'data-permission-document',
			'original',
		)
	} finally {
		await other.close()
	}
})

test('revoking admin role blocks a warm cached admin-only guide', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `role-a-${id}@example.com`,
		username: `role-a-${id}`,
		admin: true,
	})
	const operator = await seedE2eUser({
		email: `role-b-${id}@example.com`,
		username: `role-b-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/docs/admin-events')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin events' }),
	).toBeVisible()
	await page.evaluate(() => {
		document.documentElement.dataset.permissionDocument = 'original'
		window.history.pushState(null, '', '/account')
	})
	await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'View public profile', exact: true }),
	).toHaveAttribute('href', `/@${user.username}`)
	const other = await browser.newContext({ baseURL })
	try {
		const signedIn = await other.request.post('/auth', {
			data: { ...operator, mode: 'login' },
		})
		expect(signedIn.ok()).toBe(true)
		const operatorPage = await other.newPage()
		await operatorPage.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
		await waitForClientHydration(operatorPage)
		await operatorPage
			.getByRole('row')
			.filter({ hasText: user.email })
			.getByRole('link')
			.first()
			.click()
		await operatorPage
			.getByRole('combobox', { name: 'Role', exact: true })
			.selectOption('admin')
		await expect(
			operatorPage.getByRole('combobox', { name: 'Role', exact: true }),
		).toHaveValue('admin')
		const roleChangeResponse = operatorPage.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.startsWith('/_serverFn/') &&
				response.request().method() === 'POST' &&
				response.request().postData()?.includes('stableUserId') === true &&
				response.request().postData()?.includes('admin') === true,
		)
		await operatorPage
			.getByRole('button', { name: 'Remove', exact: true })
			.click()
		const changed = await roleChangeResponse
		const changeResult = await changed.text()
		expect(changed.status(), changeResult).toBe(200)
		expect(changeResult).toContain('updatedUser')
		await expect
			.poll(async () => operatorPage.locator('main').innerText())
			.toContain('Removed admin role.')
		await page.evaluate(() => {
			const check = () => {
				if (
					[...document.querySelectorAll('h1')].some(
						(heading) => heading.textContent === 'Admin events',
					) &&
					document.documentElement.dataset.staleAdminGuide !== 'visible'
				)
					document.documentElement.dataset.staleAdminGuide = 'visible'
			}
			new MutationObserver(check).observe(document, {
				childList: true,
				subtree: true,
			})
			window.history.pushState(null, '', '/docs/admin-events')
		})
		await expect(page.getByTestId('not-found-page')).toBeVisible()
		await expect(page.locator('html')).not.toHaveAttribute(
			'data-stale-admin-guide',
			'visible',
		)
		await expect(
			page.getByRole('heading', { name: 'Admin events' }),
		).toHaveCount(0)
		await expect(page.locator('html')).toHaveAttribute(
			'data-permission-document',
			'original',
		)
	} finally {
		await other.close()
	}
})

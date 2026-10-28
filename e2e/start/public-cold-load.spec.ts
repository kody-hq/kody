import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('public documents style content before hydration without script fetches', async ({
	page,
	browser,
}) => {
	const scriptRequests: Array<string> = []
	const errors: Array<string> = []
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text())
	})
	page.on('request', (request) => {
		const url = new URL(request.url())
		const path = url.pathname
		// Vite serves raw-source modules in development, those are not classic script requests.
		if (
			!url.searchParams.has('raw') &&
			/\/(page-init|emotion-style-hoist)\.js$/.test(path)
		)
			scriptRequests.push(path)
	})
	for (const path of ['/', '/pricing', '/docs']) {
		const response = await page.goto(path)
		expect(response?.status()).toBe(200)
		const csp = response!.headers()['content-security-policy']!
		const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
		expect(nonce).toBeTruthy()
		await expect(page.locator('html')).toHaveClass(/\bjs\b/)
		for (const marker of [
			'data-kody-document-init',
			'data-kody-emotion-hoist',
		]) {
			const script = page.locator(`script[${marker}]`)
			expect(
				await script.evaluate(
					(element) => (element as HTMLScriptElement).nonce,
				),
			).toBe(nonce)
			await expect(script).not.toHaveAttribute('src')
		}
		await waitForClientHydration(page)
		await expect(page.locator('h1')).toBeVisible()
		if (path === '/') {
			const unusedArt = await page.evaluate(() =>
				performance
					.getEntriesByType('resource')
					.filter((entry) => entry.name.includes('/images/hero/kody-base')),
			)
			expect(unusedArt).toEqual([])
		}
		if (process.env.KODY_EXPECT_INLINE_CSS === '1') {
			await expect(page.locator('style[data-tsr-inline-css]')).toHaveCount(1)
			await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0)
		}
	}
	expect(scriptRequests).toEqual([])
	expect(errors).toEqual([])
	// CSS remains server-rendered when scripting is unavailable.
	const context = await browser.newContext({ javaScriptEnabled: false })
	try {
		const noJs = await context.newPage()
		await noJs.goto(new URL('/pricing', page.url()).href)
		await expect(noJs.locator('h1')).toBeVisible()
		expect(
			await noJs
				.locator('body')
				.evaluate((body) => getComputedStyle(body).fontFamily),
		).toContain('Wix')
	} finally {
		await context.close()
	}
	// Route-specific landing styles also arrive on client navigation.
	await page.goto('/pricing')
	await waitForClientHydration(page)
	await page.locator('a[href="/"]').first().click()
	await expect(page.locator('.landing-hero-title')).toBeVisible()
	expect(
		await page
			.locator('.landing-hero')
			.evaluate((hero) => getComputedStyle(hero).textAlign),
	).toBe('center')
})

test('page-open motion keeps hero text readable at its first frame', async ({
	page,
}) => {
	await page.goto('/')
	await waitForClientHydration(page)
	const opacity = await page
		.locator('.landing-hero-title')
		.evaluate((title) => {
			for (const animation of title.getAnimations()) {
				animation.pause()
				animation.currentTime = 0
			}
			return getComputedStyle(title).opacity
		})
	expect(opacity).toBe('1')
})

test('docs preload the intended destination without fetching the whole sidebar', async ({
	page,
}) => {
	const requests: Array<string> = []
	page.on('request', (request) => {
		if (new URL(request.url()).pathname.includes('_serverFn'))
			requests.push(request.url())
	})
	await page.goto('/docs')
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	expect(requests).toEqual([])
	const next = page
		.locator('[data-docs-nav]')
		.getByRole('link', { name: 'Search and execute', exact: true })
	await next.hover()
	await expect.poll(() => requests.length).toBeGreaterThan(0)
	await next.click()
	await expect(page).toHaveURL(/\/docs\/search-and-execute$/)
	await expect(page.locator('h1')).toHaveText('Search and execute')
})

test('signed-in header controls survive conditional loading and server rendering', async ({
	page,
	browser,
	login,
	baseURL,
}) => {
	const errors: Array<string> = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text())
	})
	const username = `e2e-header-${Date.now().toString(36)}`
	await login({
		email: `${username}@example.com`,
		username,
		password: 'e2e-test-password',
	})
	const noJs = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await page.context().storageState(),
	})
	try {
		const plain = await noJs.newPage()
		await plain.goto(new URL('/pricing', baseURL!).href)
		await expect(plain.getByTestId('account-menu')).toBeVisible()
	} finally {
		await noJs.close()
	}
	await page.goto('/pricing')
	await waitForClientHydration(page)
	await page.getByTestId('account-menu').click()
	await expect(page.getByTestId('account-menu-panel')).toBeVisible()
	await page.keyboard.press('Escape')
	await page.setViewportSize({ width: 390, height: 844 })
	await page.getByRole('button', { name: 'Menu', exact: true }).click()
	await expect(page.getByTestId('site-menu-account')).toBeVisible()
	expect(errors).toEqual([])
})

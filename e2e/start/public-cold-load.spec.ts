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

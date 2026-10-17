import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('public SEO metadata exists without JavaScript and error pages preserve HTTP status', async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	})
	const page = await context.newPage()
	try {
		for (const [path, canonicalPath, title] of [
			[
				'/features/packages?utm_source=seo-test',
				'/features/packages',
				'Reusable packages for your AI agents | Kody',
			],
			['/docs/what-is-kody', '/docs', 'Kody Docs'],
			['/blog', '/blog', 'Blog'],
			['/pricing', '/pricing', 'Pricing'],
		]) {
			const response = await page.goto(path!)
			expect(response?.status()).toBe(200)
			await expect(page).toHaveTitle(title!)
			await expect(page.locator('head title')).toHaveCount(1)
			const canonical = page.locator('head link[rel="canonical"]')
			await expect(canonical).toHaveCount(1)
			const url = new URL((await canonical.getAttribute('href'))!)
			expect(url.pathname).toBe(canonicalPath)
			expect(url.search).toBe('')
			await expect(page.locator('head meta[name="description"]')).toHaveCount(1)
		}
		for (const [path, status] of [
			['/404', 404],
			['/500', 500],
			['/seo-missing-page', 404],
		] as const) {
			const response = await page.goto(path)
			expect(response?.status()).toBe(status)
			await expect(
				page.locator('head link[rel="canonical"], head meta[property^="og:"]'),
			).toHaveCount(0)
		}
	} finally {
		await context.close()
	}
})

test('client navigation replaces public share metadata and keeps one canonical URL', async ({
	page,
}) => {
	await page.goto('/features/packages')
	await waitForClientHydration(page)
	await page.evaluate(() => {
		document.documentElement.dataset.seoDocument = 'original'
	})
	await page.locator('a[href="/pricing"]').first().click()
	await expect(page).toHaveURL(/\/pricing$/)
	await expect(page).toHaveTitle('Pricing')
	await expect(page.locator('html')).toHaveAttribute(
		'data-seo-document',
		'original',
	)
	await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1)
	await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
		'href',
		/\/pricing$/,
	)
	for (const selector of [
		'meta[property="og:url"]',
		'meta[property="og:image"]',
		'meta[name="twitter:image"]',
	]) {
		await expect(page.locator(`head ${selector}`)).toHaveCount(1)
	}
	await expect(page.locator('head meta[property="og:url"]')).toHaveAttribute(
		'content',
		/\/pricing$/,
	)
	await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute(
		'content',
		/\/og\/pricing\.png$/,
	)
	await page.goBack()
	await expect(page).toHaveURL(/\/features\/packages$/)
	await expect(page).toHaveTitle('Reusable packages for your AI agents | Kody')
	await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1)
	await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
		'href',
		/\/features\/packages$/,
	)
})

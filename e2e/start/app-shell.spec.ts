import { expect, test } from '../playwright-utils.ts'

test('shell keeps auth full height and restores mobile gutters and attribution', async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		viewport: { width: 390, height: 844 },
	})
	try {
		const page = await context.newPage()
		await page.goto(
			'/support?utm_source=shell-regression&utm_campaign=private-preview',
		)
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true')
		const padding = await page
			.locator('main')
			.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft))
		expect(padding).toBeGreaterThan(0)
		const attribution = await page.evaluate(() =>
			sessionStorage.getItem('kody.firstTouchAttribution'),
		)
		expect(attribution).toContain('shell-regression')
		expect(attribution).toContain('private-preview')
		await page.goto('/?og=shared&utm_source=other')
		await expect(page).not.toHaveURL(/[?&]og=/)
		await expect(page).toHaveURL(/utm_source=other/)
		expect(
			await page.evaluate(() =>
				sessionStorage.getItem('kody.firstTouchAttribution'),
			),
		).toBe(attribution)
		await page.goto('/docs/secrets')
		await expect(page.locator('main')).toHaveCSS('padding-left', '0px')
		await page.goto('/login')
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true')
		const frame = await page.locator('[data-app-frame]').boundingBox()
		expect(frame?.height).toBeGreaterThanOrEqual(844)
		await expect(page.locator('main')).toHaveCSS('display', 'grid')
	} finally {
		await context.close()
	}
})

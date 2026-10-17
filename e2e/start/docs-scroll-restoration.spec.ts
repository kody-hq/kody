import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('native docs navigation resets scroll and restores distinct Back and Forward positions', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 720 })
	// Both real guides have long articles and a persistent desktop sidebar.
	await page.goto('/docs/memory')
	await waitForClientHydration(page)
	await expect(page.locator('main h1')).toHaveText('Shared memory')
	await page.evaluate(() => document.fonts.ready)
	const timeOrigin = await page.evaluate(() => performance.timeOrigin)
	const memoryY = await page.evaluate(() => {
		const maximum = document.documentElement.scrollHeight - window.innerHeight
		return Math.min(400, Math.floor(maximum / 3))
	})
	expect(memoryY).toBeGreaterThan(100)
	await page.evaluate(
		(top) => window.scrollTo({ top, behavior: 'instant' }),
		memoryY,
	)
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeCloseTo(memoryY, 0)

	await page
		.locator('[data-docs-nav]')
		.getByRole('link', { name: 'Secrets', exact: true })
		.click()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(page.locator('main h1')).toHaveText('Secrets')
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeLessThanOrEqual(2)
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)

	const secretsY = await page.evaluate(() => {
		const maximum = document.documentElement.scrollHeight - window.innerHeight
		return Math.min(900, Math.floor((maximum * 2) / 3))
	})
	expect(secretsY).toBeGreaterThan(memoryY + 100)
	await page.evaluate(
		(top) => window.scrollTo({ top, behavior: 'instant' }),
		secretsY,
	)
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeCloseTo(secretsY, 0)

	await page.goBack()
	await expect(page).toHaveURL(/\/docs\/memory$/)
	await expect(page.locator('main h1')).toHaveText('Shared memory')
	await expect
		.poll(async () =>
			Math.abs((await page.evaluate(() => window.scrollY)) - memoryY),
		)
		.toBeLessThanOrEqual(2)
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)

	await page.goForward()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(page.locator('main h1')).toHaveText('Secrets')
	await expect
		.poll(async () =>
			Math.abs((await page.evaluate(() => window.scrollY)) - secretsY),
		)
		.toBeLessThanOrEqual(2)
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
})

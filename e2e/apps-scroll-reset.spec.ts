import { randomUUID } from 'node:crypto'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('opening Apps from a scrolled page starts at the top', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 60_000)
	const username = `apps-scroll-${randomUUID().slice(0, 8)}`
	const owner = await seedE2eUser({
		username,
		email: `${username}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	// Short enough that both pages scroll.
	await page.setViewportSize({ width: 390, height: 320 })
	await page.goto(`/@${username}/-/overview`)
	await waitForClientHydration(page)
	await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'instant' }))
	expect(await page.evaluate(() => window.scrollY)).toBe(200)
	await page
		.locator(`a[href="/@${username}/-/apps"]`)
		.first()
		.evaluate((link: HTMLElement) => link.click())
	// Apps adds the saved view to the URL as it mounts.
	await expect(page).toHaveURL(/\/-\/apps\?view=cards$/)
	await expect(
		page.getByRole('heading', { name: 'Apps', level: 1 }),
	).toBeVisible()
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})

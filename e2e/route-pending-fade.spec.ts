import { randomUUID } from 'node:crypto'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('a slow page load keeps the current page on screen, dimmed', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 60_000)
	const username = `pending-fade-${randomUUID().slice(0, 8)}`
	const owner = await seedE2eUser({
		username,
		email: `${username}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${username}/-/overview`)
	await waitForClientHydration(page)
	const main = page.locator('main#main')
	const overview = page.getByRole('heading', { name: 'Overview', level: 1 })
	const loader = page.getByRole('status', { name: 'Loading', exact: true })
	await expect(overview).toBeVisible()
	await main.evaluate((node) => node.setAttribute('data-kept', ''))

	let release = () => {}
	const held = new Promise<void>((resolve) => (release = resolve))
	await page.route('**/_serverFn/**', async (route) => {
		await held
		await route.continue()
	})
	await page
		.locator(`a[href="/@${username}/-/apps"]`)
		.first()
		.evaluate((link: HTMLElement) => link.click())

	// Too soon for any feedback beyond the progress bar.
	await expect(main).toHaveCSS('opacity', '1')
	await expect(page.locator('html')).toHaveAttribute('data-route-pending', '')
	await expect(main).toHaveCSS('opacity', '0.6')
	// Longer than the router's stock one-second wait before a pending screen.
	await page.waitForTimeout(1_600)
	await expect(overview).toBeVisible()
	await expect(loader).toHaveCount(0)
	await expect(page.locator('main#main[data-kept]')).toHaveCount(1)
	await expect(page.locator('[data-navigation-progress]')).toHaveCount(1)

	release()
	await expect(
		page.getByRole('heading', { name: 'Apps', level: 1 }),
	).toBeVisible()
	await expect(page.locator('html')).not.toHaveAttribute('data-route-pending')
	await expect(main).toHaveCSS('opacity', '1')
	await expect(loader).toHaveCount(0)
})

test('a quick page load never dims the page', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 60_000)
	const username = `pending-quick-${randomUUID().slice(0, 8)}`
	const owner = await seedE2eUser({
		username,
		email: `${username}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${username}/-/overview`)
	await waitForClientHydration(page)
	// The page's clock only moves when told to, so the load below lasts 400 ms
	// however long the server takes.
	await page.clock.install()
	await page.clock.pauseAt(Date.now() + 60_000)
	await page.evaluate(() => {
		const seen = { dimmed: false }
		;(window as { seen?: typeof seen }).seen = seen
		new MutationObserver(() => {
			if (document.documentElement.hasAttribute('data-route-pending'))
				seen.dimmed = true
		}).observe(document.documentElement, { attributes: true })
	})
	let release = () => {}
	const held = new Promise<void>((resolve) => (release = resolve))
	await page.route('**/_serverFn/**', async (route) => {
		await held
		await route.continue()
	})
	await page
		.locator(`a[href="/@${username}/-/apps"]`)
		.first()
		.evaluate((link: HTMLElement) => link.click())
	await page.clock.runFor(400)
	release()
	await expect(
		page.getByRole('heading', { name: 'Apps', level: 1 }),
	).toBeVisible()
	// Apps then settles its view into the URL, a second, unheld load.
	await expect(page).toHaveURL(/\/-\/apps\?view=cards$/)
	await page.waitForLoadState('networkidle')
	await page.clock.runFor(2_000)
	expect(
		await page.evaluate(() => (window as { seen?: { dimmed: boolean } }).seen),
	).toEqual({ dimmed: false })
})

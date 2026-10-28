import { expect, test, waitForClientHydration } from './playwright-utils.ts'

const viewports = [
	{ name: 'desktop', width: 1440, height: 900 },
	{ name: 'mobile', width: 390, height: 844 },
]

async function readScroll(page: import('@playwright/test').Page) {
	return page.evaluate(() => ({
		windowY: window.scrollY,
		rail: document.querySelector('[data-workspace-scroll]')?.scrollTop ?? null,
		main: document.querySelector('main#main')?.scrollTop ?? null,
		mainTop: document.querySelector('main#main')?.getBoundingClientRect().top,
	}))
}

for (const viewport of viewports) {
	test(`Overview first load starts at the top (${viewport.name})`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		test.setTimeout(process.env.CI ? 90_000 : 60_000)
		await page.setViewportSize(viewport)
		const runId = `${viewport.name[0]}-${Date.now() % 100_000_000}`
		const user = await seedE2eUser({
			email: `ovs-${runId}@example.com`,
			username: `ovs-${runId}`,
			password: 'overview-scroll-password',
		})
		await login({ email: user.email, password: user.password, mode: 'login' })
		const overview = `/@${user.username}/-/overview`

		await page.goto(overview)
		await waitForClientHydration(page)
		await expect(page.locator('main#main')).toBeVisible()
		const cold = await readScroll(page)
		expect(cold).toMatchObject({ windowY: 0, rail: 0, main: 0 })
		expect(cold.mainTop).toBeGreaterThanOrEqual(0)
		expect(cold.mainTop).toBeLessThan(viewport.height / 2)

		// Entering Overview from a scrolled workspace page must not keep the offset.
		await page.goto(`/@${user.username}/-/credentials/new?kind=secret`)
		await waitForClientHydration(page)
		await page.evaluate(() =>
			window.scrollTo(0, document.documentElement.scrollHeight),
		)
		await expect
			.poll(() => page.evaluate(() => window.scrollY))
			.toBeGreaterThan(0)
		if (viewport.name === 'mobile') {
			// Narrow layouts navigate through the menu drawer, which closes on click.
			const menu = page
				.locator('details')
				.filter({ has: page.locator(`nav a[href="${overview}"]`) })
				.first()
			await menu.locator('summary').click()
			await menu.locator(`nav a[href="${overview}"]`).click()
		} else {
			await page.locator(`a[href="${overview}"]:visible`).first().click()
		}
		await expect(page).toHaveURL(new RegExp(`${overview}$`))
		await expect
			.poll(() => readScroll(page))
			.toMatchObject({ windowY: 0, rail: 0, main: 0 })
	})
}

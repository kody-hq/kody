import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test.use({ reducedMotion: 'reduce' })

test('workspace keeps its sidebar across pages and remains separate from the website', async ({
	page,
	seedE2eUser,
	login,
}, testInfo) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const user = await seedE2eUser({
		email: `workspace-layout-${Date.now()}@example.com`,
		username: `layout-${Date.now()}`,
		password: 'workspace-layout-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/')
	await waitForClientHydration(page)
	await expect(page.locator('[data-workspace-layout]')).toHaveCount(0)
	await page.getByRole('link', { name: 'Workspace', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/overview$`))
	const sidebar = page.getByRole('complementary', {
		name: 'Workspace navigation',
	})
	await expect(sidebar).toBeVisible()
	await expect(page.getByRole('main')).toHaveCount(1)
	await expect(page.locator('.site-header')).toHaveCount(0)
	const historyChart = page.getByRole('img', {
		name: 'Daily top-level executions by outcome over the last seven UTC days',
	})
	await expect(historyChart).toBeVisible()
	await page.setViewportSize({ width: 390, height: 844 })
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true)
	await expect(historyChart).toBeVisible()
	await page.screenshot({
		path: testInfo.outputPath('workspace-charts-mobile.png'),
		animations: 'disabled',
	})
	await page.setViewportSize({ width: 1440, height: 900 })
	const panel = page.locator('[data-workspace-panel]')
	await expect
		.poll(() =>
			panel.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)),
		)
		.toBeGreaterThan(0)
	await sidebar.evaluate((el) => el.setAttribute('data-retained', 'true'))
	await sidebar.getByRole('link', { name: 'Repositories', exact: true }).click()
	await expect(
		page.getByRole('heading', { level: 1, name: 'Repositories', exact: true }),
	).toBeVisible()
	await expect(sidebar).toHaveAttribute('data-retained', 'true')
	await expect(
		sidebar.getByRole('link', { name: 'Repositories', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(
		sidebar.getByRole('link', { name: 'Overview', exact: true }),
	).not.toHaveAttribute('aria-current')
	await page.screenshot({
		path: testInfo.outputPath('workspace-desktop.png'),
		animations: 'disabled',
	})
	await sidebar.getByTestId('account-menu').click()
	const menu = page.getByTestId('account-menu-panel')
	await expect(menu).toBeVisible()
	const bounds = await menu.boundingBox()
	expect(bounds).not.toBeNull()
	expect(bounds!.x).toBeGreaterThanOrEqual(0)
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440)
	await page.keyboard.press('Escape')
	await page.setViewportSize({ width: 390, height: 844 })
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true)
	await sidebar
		.getByText('Repositories', { exact: true })
		.filter({ visible: true })
		.click()
	await sidebar
		.getByRole('link', { name: 'Jobs', exact: true })
		.filter({ visible: true })
		.click()
	await expect(
		page.getByRole('heading', { level: 1, name: 'Jobs', exact: true }),
	).toBeVisible()
	await expect(sidebar.locator('details')).not.toHaveAttribute('open', '')
	await page.screenshot({
		path: testInfo.outputPath('workspace-mobile.png'),
		animations: 'disabled',
	})
	await sidebar.getByRole('link', { name: 'Kody home', exact: true }).click()
	await expect(page).toHaveURL('/')
	await expect(page.locator('[data-workspace-layout]')).toHaveCount(0)
	await expect(
		page.getByRole('link', { name: 'Workspace', exact: true }),
	).toBeVisible()
})

test('workspace content widths follow the page layout on wide screens', async ({
	page,
	seedE2eUser,
	login,
}, testInfo) => {
	const user = await seedE2eUser({
		email: `workspace-width-${Date.now()}@example.com`,
		username: `width-${Date.now()}`,
		password: 'workspace-width-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.setViewportSize({ width: 2560, height: 1440 })
	await page.goto('/account/passkeys')
	await waitForClientHydration(page)
	const form = page.locator('[data-workspace-page-layout="form"]')
	await expect(form).toBeVisible()
	const bounds = await form.boundingBox()
	expect(bounds!.width).toBe(800)
	const panel = page.locator('[data-workspace-panel]')
	const panelBounds = await panel.boundingBox()
	expect(bounds!.x - panelBounds!.x).toBeLessThanOrEqual(40)
	await page.screenshot({
		path: testInfo.outputPath('workspace-wide-form.png'),
	})
	await page.goto(`/@${user.username}/-/repositories`)
	await waitForClientHydration(page)
	const list = page.locator('[data-workspace-page-layout="list"]')
	await expect(list).toBeVisible()
	expect((await list.boundingBox())!.width).toBeGreaterThan(1800)
	await page.goto(`/@${user.username}/-/overview`)
	await waitForClientHydration(page)
	const dashboard = page.locator('[data-workspace-page-layout="dashboard"]')
	await expect(dashboard).toBeVisible()
	expect((await dashboard.boundingBox())!.width).toBeGreaterThan(1800)
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/account/passkeys')
	await waitForClientHydration(page)
	await expect(form).toBeVisible()
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true)
	await page.screenshot({
		path: testInfo.outputPath('workspace-mobile-form.png'),
	})
})

import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { type Locator, type Page } from '@playwright/test'

async function watchControl(
	page: Page,
	control: Locator,
	requireScroll = true,
) {
	await control.evaluate((element) => {
		element.scrollIntoView({ block: 'center', behavior: 'instant' })
		element.setAttribute('data-scroll-check', 'original')
	})
	const before = await page.evaluate(() => window.scrollY)
	if (requireScroll) expect(before).toBeGreaterThan(0)
	const original = await control.elementHandle()
	const top = await control.evaluate(
		(element) => element.getBoundingClientRect().top,
	)
	return async () => {
		expect(await original!.evaluate((element) => element.isConnected)).toBe(
			true,
		)
		expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0)
		expect(
			await control.evaluate((element) => element.getBoundingClientRect().top),
		).toBeCloseTo(top, 0)
	}
}

test('skills search, sorting, page size and view keep the mounted table and scroll', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `scroll-${id}@example.com`,
		username: `scroll-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.setViewportSize({ width: 1280, height: 350 })
	await page.goto(`/@${user.username}/-/skills`)
	await waitForClientHydration(page)
	const search = page.getByRole('searchbox', { name: 'Search skills' })
	const check = await watchControl(page, search)
	const reads: string[] = []
	page.on('request', (request) => {
		if (request.url().includes('/_serverFn/')) reads.push(request.url())
	})
	await search.fill('example')
	await expect(page).toHaveURL(/q=example/)
	await check()
	await page.getByRole('combobox', { name: 'Sort skills', exact: true }).click()
	await page.getByRole('option', { name: 'Most read', exact: true }).click()
	await expect(page).toHaveURL(/sort=reads/)
	await check()
	await page.getByLabel('Rows per page', { exact: true }).selectOption('50')
	await expect(page).toHaveURL(/pageSize=50/)
	const view = page.getByRole('link', { name: 'By package', exact: true })
	const checkView = await watchControl(page, view)
	await view.click()
	await expect(page).toHaveURL(/view=packages/)
	await checkView()
	await expect(search).toHaveAttribute('data-scroll-check', 'original')
	expect(reads).toEqual([])
	await page.goBack()
	await expect(page).not.toHaveURL(/view=packages/)
	await expect(search).toHaveAttribute('data-scroll-check', 'original')
	await page.getByRole('link', { name: 'Overview', exact: true }).click()
	await expect(page).toHaveURL(/\/overview$/)
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})

test('admin feedback and system inbox filters retain controls during slow reads', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `scroll-admin-${id}@example.com`,
		username: `scroll-admin-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.setViewportSize({ width: 1280, height: 250 })
	for (const scenario of [
		{
			path: '/admin/platform-feedback',
			label: 'Filter feedback by status',
			option: 'Open',
			value: 'open',
			query: 'status=open',
		},
		{
			path: '/admin/system-email',
			label: 'Filter system mail by view',
			option: 'All mail',
			value: 'all',
			query: 'view=all',
		},
	]) {
		await page.goto(scenario.path)
		await waitForClientHydration(page)
		const control = page.getByRole('combobox', {
			name: scenario.label,
			exact: true,
		})
		const check = await watchControl(page, control)
		const requests: string[] = []
		await page.route('**/_serverFn/**', async (route) => {
			requests.push(decodeURIComponent(route.request().url()))
			await new Promise((resolve) => setTimeout(resolve, 500))
			await route.continue()
		})
		await control.click()
		await page
			.getByRole('option', { name: scenario.option, exact: true })
			.click()
		await expect(page).toHaveURL(new RegExp(scenario.query))
		await check()
		await expect.poll(() => requests.join('\n')).toContain(scenario.value)
		await expect(control).toHaveValue(scenario.option)
		await page.unrouteAll({ behavior: 'wait' })
		await check()
	}
})

for (const width of [1280, 390]) {
	test(`workspace searches keep their controls, focus and scroll at ${width}px`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		test.setTimeout(120_000)
		const id = randomUUID().slice(0, 8)
		const user = await seedE2eUser({
			email: `search-${id}@example.com`,
			username: `search-${id}`,
		})
		await login({ ...user, mode: 'login' })
		await page.setViewportSize({ width, height: 350 })
		for (const [section, label] of [
			['jobs', 'Search jobs'],
			['workflows', 'Search workflows'],
			['memories', 'Search memories'],
			['credentials', 'Search credentials'],
			['mcp-servers', 'Search credentials'],
			['mcp-servers/new', 'Search servers'],
			['secrets/new', 'Search secrets'],
			['integrations', 'Search credentials'],
			['email', 'Search messages'],
		]) {
			await page.goto(`/@${user.username}/-/${section}`)
			await waitForClientHydration(page)
			const search = page.getByRole('searchbox', { name: label, exact: true })
			await expect(search, `${section} search is available`).toBeVisible({
				timeout: 5_000,
			})
			const check = await watchControl(page, search, false)
			await search.fill('example')
			await expect(page).toHaveURL(/q=example/)
			await expect(search).toBeFocused()
			await check()
			await search.pressSequentially('123')
			await expect(page).toHaveURL(/q=example123/)
			await expect(search).toHaveValue('example123')
			await check()
		}
	})
}

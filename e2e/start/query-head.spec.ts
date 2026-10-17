import { randomUUID } from 'node:crypto'
import { type Request } from '@playwright/test'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from '../playwright-utils.ts'

async function expectProfileHead(page: Page, name: string, bio: string) {
	await expect(page.getByTestId('profile-display-name')).toHaveText(name)
	await expect(page.getByTestId('profile-bio')).toHaveText(bio)
	await expect(page).toHaveTitle(name)
	await expect(page.locator('head title')).toHaveCount(1)
	for (const selector of [
		'meta[name="description"]',
		'meta[property="og:description"]',
		'meta[name="twitter:description"]',
	]) {
		await expect(page.locator(`head ${selector}`)).toHaveCount(1)
		await expect(page.locator(`head ${selector}`)).toHaveAttribute(
			'content',
			bio,
		)
	}
	for (const selector of [
		'meta[property="og:title"]',
		'meta[name="twitter:title"]',
	]) {
		await expect(page.locator(`head ${selector}`)).toHaveCount(1)
		await expect(page.locator(`head ${selector}`)).toHaveAttribute(
			'content',
			new RegExp(`^${name} `),
		)
	}
	await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1)
}

async function saveProfile(page: Page, name: string, bio: string) {
	await page.getByLabel('Display name', { exact: true }).fill(name)
	await page.getByRole('textbox', { name: 'Bio', exact: true }).fill(bio)
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname.startsWith('/_serverFn/') &&
			(response.request().postData() ?? '').includes(name) &&
			response.request().method() === 'POST',
	)
	await page.getByRole('button', { name: 'Save profile', exact: true }).click()
	expect((await saved).ok()).toBe(true)
	await expect(
		page.getByRole('button', { name: 'Save profile', exact: true }),
	).toBeDisabled()
}

test('external profile edits refresh body and metadata together on focus, reconnect and authorized reentry', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `head-${id}@example.com`,
		username: `head-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const reader = await page.context().newPage()
	const errors: string[] = []
	reader.on('pageerror', (error) => errors.push(error.message))
	reader.on('console', (message) => {
		if (
			message.type() === 'error' &&
			/hydration|didn't match|React client error/i.test(message.text())
		)
			errors.push(message.text())
	})
	try {
		await saveProfile(page, `First ${id}`, `First bio ${id}`)
		const initialResponse = await reader.request.get(`/@${user.username}`)
		expect(initialResponse.ok()).toBe(true)
		const html = await initialResponse.text()
		expect([...html.matchAll(/<title(?:\s[^>]*)?>/g)]).toHaveLength(1)
		expect(html).toContain(`First bio ${id}`)
		const csp = initialResponse.headers()['content-security-policy']
		const nonce = csp?.match(/'nonce-([^']+)'/)?.[1]
		expect(nonce).toBeTruthy()
		const scriptNonces = [
			...html.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/g),
		].map((match) => match[1])
		expect(scriptNonces.length).toBeGreaterThan(0)
		expect(scriptNonces.every((value) => value === nonce)).toBe(true)
		await reader.goto(`/@${user.username}`)
		await waitForClientHydration(reader)
		await expectProfileHead(reader, `First ${id}`, `First bio ${id}`)
		await reader.clock.install()
		await reader.evaluate(() => {
			document.documentElement.dataset.headDocument = 'original'
		})
		for (const event of ['focus', 'online'] as const) {
			await saveProfile(page, `${event} ${id}`, `${event} bio ${id}`)
			await reader.waitForLoadState('networkidle')
			const reads: string[] = []
			const record = (request: Request) => {
				if (
					request.url().includes('/_serverFn/') &&
					decodeURIComponent(request.url()).includes(user.username)
				)
					reads.push(request.url())
			}
			reader.on('request', record)
			await reader.clock.fastForward(31_000)
			await reader.evaluate(
				(event) => window.dispatchEvent(new Event(event)),
				event,
			)
			await expectProfileHead(reader, `${event} ${id}`, `${event} bio ${id}`)
			await reader.waitForLoadState('networkidle')
			expect(reads).toHaveLength(1)
			reader.off('request', record)
		}
		await reader.evaluate(() => window.history.pushState(null, '', '/pricing'))
		await expect(reader.locator('main')).toContainText('Worker compute')
		const pricingTitle = await reader.title()
		const pricingDescription = await reader
			.locator('head meta[name="description"]')
			.getAttribute('content')
		await saveProfile(page, `SWR ${id}`, `SWR bio ${id}`)
		await reader.clock.fastForward(31_000)
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let started!: () => void
		const reading = new Promise<void>((resolve) => {
			started = resolve
		})
		let readCount = 0
		await reader.route('**/_serverFn/**', async (route) => {
			if (decodeURIComponent(route.request().url()).includes(user.username)) {
				readCount++
				started()
				await held
			}
			await route.continue()
		})
		try {
			await reader.evaluate(
				(href) => window.history.pushState(null, '', href),
				`/@${user.username}`,
			)
			await reading
			// This route also serves private organization homes and profiles whose
			// visibility can change. Reentry must confirm access before cache reuse.
			await expect(reader.locator('main')).toContainText('Worker compute')
			await expect(reader.getByTestId('profile-display-name')).toHaveCount(0)
			await expect(reader).toHaveTitle(pricingTitle)
			await expect(
				reader.locator('head meta[name="description"]'),
			).toHaveAttribute('content', pricingDescription!)
			release()
			await expectProfileHead(reader, `SWR ${id}`, `SWR bio ${id}`)
			await reader.waitForLoadState('networkidle')
			expect(readCount).toBe(1)
		} finally {
			release()
			await reader.unrouteAll({ behavior: 'wait' })
		}
		await expect(reader.locator('html')).toHaveAttribute(
			'data-head-document',
			'original',
		)
		expect(errors).toEqual([])
	} finally {
		await reader.close()
	}
})

test('pending navigation retains the committed profile head until the destination is ready', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `head-pending-${id}@example.com`,
		username: `head-pending-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto(`/@${user.username}`)
	await waitForClientHydration(page)
	const previousTitle = await page.title()
	const previousDescription = await page
		.locator('head meta[name="description"]')
		.getAttribute('content')
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let started!: () => void
	const reading = new Promise<void>((resolve) => {
		started = resolve
	})
	await page.route('**/_serverFn/**', async (route) => {
		if (decodeURIComponent(route.request().url()).includes('"secrets"')) {
			started()
			await held
		}
		await route.continue()
	})
	try {
		await page.evaluate(() =>
			window.history.pushState(null, '', '/docs/secrets'),
		)
		await reading
		await expect(page.getByTestId('profile-display-name')).toBeVisible()
		await expect(page).toHaveTitle(previousTitle)
		await expect(page.locator('head meta[name="description"]')).toHaveAttribute(
			'content',
			previousDescription!,
		)
		release()
		await expect(page.locator('main h1')).toContainText('Secrets')
		await expect(page).not.toHaveTitle(previousTitle)
		await expect(page.locator('head title')).toHaveCount(1)
		await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1)
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

test('background permission failure removes cached private document metadata', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `head-role-${id}@example.com`,
		username: `head-role-${id}`,
		admin: true,
	})
	const operator = await seedE2eUser({
		email: `head-operator-${id}@example.com`,
		username: `head-operator-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/docs/admin-events')
	await waitForClientHydration(page)
	await expect(page.locator('main h1')).toContainText('Admin')
	const privateTitle = await page.title()
	await page.evaluate(() => {
		document.documentElement.dataset.headDocument = 'original'
	})
	const other = await browser.newContext({ baseURL })
	try {
		expect(
			(
				await other.request.post('/auth', {
					data: { ...operator, mode: 'login' },
				})
			).ok(),
		).toBe(true)
		const operatorPage = await other.newPage()
		await operatorPage.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
		await waitForClientHydration(operatorPage)
		await operatorPage
			.getByRole('row')
			.filter({ hasText: user.email })
			.getByRole('link')
			.first()
			.click()
		await operatorPage
			.getByRole('combobox', { name: 'Role', exact: true })
			.selectOption('admin')
		await expect(
			operatorPage.getByRole('combobox', { name: 'Role', exact: true }),
		).toHaveValue('admin')
		const roleChangeResponse = operatorPage.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.startsWith('/_serverFn/') &&
				response.request().method() === 'POST' &&
				response.request().postData()?.includes('stableUserId') === true &&
				response.request().postData()?.includes('admin') === true,
		)
		await operatorPage
			.getByRole('button', { name: 'Remove', exact: true })
			.click()
		const changed = await roleChangeResponse
		const changeResult = await changed.text()
		expect(changed.status(), changeResult).toBe(200)
		expect(changeResult).toContain('updatedUser')
		await expect(
			operatorPage.getByText('Removed admin role.', { exact: true }),
		).toBeVisible()
		const denied = page.waitForResponse(
			(response) =>
				response.url().includes('/_serverFn/') &&
				decodeURIComponent(response.url()).includes('admin-events'),
		)
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
		expect(await (await denied).text()).toContain('isNotFound')
		await expect(page).toHaveTitle('Not found')
		await expect(page.getByTestId('not-found-page')).toBeVisible()
		await expect(page).toHaveTitle('Not found')
		await expect(page).not.toHaveTitle(privateTitle)
		await expect(
			page.locator(
				'head meta[property^="og:"], head meta[name^="twitter:"], head meta[name="description"], head link[rel="canonical"]',
			),
		).toHaveCount(0)
		await page.clock.install()
		await page.clock.fastForward(31 * 60_000)
		await expect(page).toHaveTitle('Not found')
		await expect(
			page.locator(
				'head meta[property^="og:"], head meta[name="description"], head link[rel="canonical"]',
			),
		).toHaveCount(0)
		await expect(
			page.locator('head meta[name="kody-document-actor"]'),
		).toHaveCount(1)
		await expect(page.locator('html')).toHaveAttribute(
			'data-head-document',
			'original',
		)
	} finally {
		await other.close()
	}
})

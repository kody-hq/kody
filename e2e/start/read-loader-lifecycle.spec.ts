import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from '../playwright-utils.ts'

const renderErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
	const errors: string[] = []
	renderErrors.set(page, errors)
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (
			message.type() === 'error' &&
			message.text().includes('React client error')
		)
			errors.push(message.text())
	})
})
test.afterEach(({ page }) => {
	expect(renderErrors.get(page)).toEqual([])
})

async function navigate(page: Page, href: string) {
	// Browser history is observed by the router. Avoid intent prefetch here so
	// this test owns one navigation request rather than a separate preload.
	await page.evaluate((href) => window.history.pushState(null, '', href), href)
}

test('superseded navigation retains its Query read without replacing the next page', async ({
	page,
}) => {
	await page.goto('/faq')
	await waitForClientHydration(page)
	const originalHeading = await page.locator('main h1').innerText()
	let readCount = 0
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let started!: () => void
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve
	})
	const isSecretsRead = (url: string) =>
		decodeURIComponent(url).includes('"secrets"')
	await page.route('**/_serverFn/**', async (route) => {
		if (isSecretsRead(route.request().url())) {
			readCount += 1
			started()
			await held
		}
		await route.continue()
	})
	try {
		await navigate(page, '/docs/secrets')
		await requestStarted
		await expect(page.locator('main h1')).toHaveText(originalHeading, {
			useInnerText: true,
		})
		const completed = page.waitForResponse((response) =>
			isSecretsRead(response.url()),
		)
		await navigate(page, '/pricing')
		await expect(page.locator('main')).toContainText('Worker compute')
		// Query owns this shared read. It can finish for a later visit without
		// committing the abandoned navigation or replacing the current screen.
		release()
		expect((await completed).ok()).toBe(true)
		await page.waitForLoadState('networkidle')
		await expect(page).toHaveURL(/\/pricing$/)
		await expect(page.locator('main')).toContainText('Worker compute')
		await navigate(page, '/docs/secrets')
		await expect(page.locator('main h1')).toContainText('Secrets')
		await page.waitForLoadState('networkidle')
		expect(readCount).toBe(1)
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
	await page.waitForLoadState('networkidle')
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(page.locator('main h1')).toContainText('Secrets')
})

test('blog cache keeps slug identity, ignores tracking search, and expires', async ({
	page,
}) => {
	await page.goto('/blog')
	await waitForClientHydration(page)
	const indexHeading = await page.locator('main h1').innerText()
	const links = await page
		.locator('main a[href^="/blog/"]:not([href="/blog/rss.xml"])')
		.evaluateAll((anchors) => [
			...new Set(anchors.map((anchor) => anchor.getAttribute('href')!)),
		])
	expect(links.length).toBeGreaterThanOrEqual(2)
	const [first, second] = links as [string, string, ...string[]]
	const firstSlug = first.split('/').filter(Boolean).at(-1)!
	const reads: string[] = []
	page.on('request', (request) => {
		if (
			request.headers()['x-tsr-serverfn'] &&
			decodeURIComponent(request.url()).includes(JSON.stringify(firstSlug))
		) {
			reads.push(request.url())
		}
	})
	await page.clock.install()
	await navigate(page, `${first}?utm_source=first`)
	await expect(page).toHaveURL(new RegExp(`${first}\\?`))
	// pushState updates the URL synchronously, before the asynchronous loader
	// starts. An already-idle network does not prove that navigation committed.
	await expect(page.locator('main h1')).not.toHaveText(indexHeading)
	await page.waitForLoadState('networkidle')
	const firstHeading = await page.locator('main h1').innerText()
	expect(reads).toHaveLength(1)
	await navigate(page, second)
	await expect(page.locator('main h1')).not.toHaveText(firstHeading)
	await page.waitForLoadState('networkidle')
	await navigate(page, `${first}?utm_source=second`)
	await expect(page.locator('main h1')).toHaveText(firstHeading)
	await page.waitForLoadState('networkidle')
	expect(reads).toHaveLength(1)
	await page.clock.fastForward(5 * 60_000 + 1_000)
	await navigate(page, second)
	await expect(page.locator('main h1')).not.toHaveText(firstHeading)
	await navigate(page, `${first}?utm_source=third`)
	await expect(page.locator('main h1')).toHaveText(firstHeading)
	await expect.poll(() => reads.length).toBe(2)
})

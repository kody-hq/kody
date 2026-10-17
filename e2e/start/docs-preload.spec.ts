import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('docs render preload the next article and reuse it without blocking reads', async ({
	page,
}) => {
	const start = Date.now()
	const reads: string[] = []
	page.on('request', (request) => {
		if (new URL(request.url()).pathname.startsWith('/_serverFn/'))
			reads.push(decodeURIComponent(request.url()))
	})
	const nextReady = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname.startsWith('/_serverFn/') &&
			decodeURIComponent(response.url()).includes('"search-and-execute"') &&
			response.status() === 200,
	)
	await page.goto('/docs')
	await waitForClientHydration(page)
	await (await nextReady).finished()
	await page.waitForLoadState('networkidle')
	const preloadedAfterMs = Date.now() - start
	expect(reads.some((url) => url.includes('"admin-events"'))).toBe(false)
	const readsAfterPreload: string[] = []
	// If navigation needs another server read it cannot complete. This checks
	// cache reuse rather than hiding a pending indicator or assuming a timing.
	await page.route('**/_serverFn/**', async (route) => {
		readsAfterPreload.push(route.request().url())
		await route.abort()
	})
	const next = page
		.locator('[data-docs-nav]')
		.getByRole('link', { name: 'Search and execute', exact: true })
	const firstClick = Date.now()
	await next.click()
	await expect(page).toHaveURL(/\/docs\/search-and-execute$/)
	await expect(page.locator('main h1')).toContainText('Search and execute')
	const firstNavigationMs = Date.now() - firstClick
	await page
		.locator('[data-docs-nav]')
		.getByRole('link', { name: 'What is Kody?', exact: true })
		.click()
	await expect(page.locator('main h1')).toContainText('What is Kody')
	const revisit = Date.now()
	await next.click()
	await expect(page.locator('main h1')).toContainText('Search and execute')
	const revisitMs = Date.now() - revisit
	expect(readsAfterPreload).toEqual([])
	console.log(
		JSON.stringify({
			preloadedAfterMs,
			firstNavigationMs,
			revisitMs,
			blockingReads: readsAfterPreload.length,
		}),
	)
})

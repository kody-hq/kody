import {
	collectJsonRequests,
	expectSingleCommitTransition,
	observeMainTransitions,
	readMainTransitions,
} from './main-transitions.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('docs guide switches keep the current article on screen until the next one is ready (no loading flash)', async ({
	page,
}) => {
	await page.context().clearCookies()
	const docRequests = collectJsonRequests(page)

	await page.goto('/docs/memory')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Shared memory' }),
	).toBeVisible()
	const sidebar = page.getByRole('navigation', { name: 'Docs' }).first()
	const secretsLink = sidebar.getByRole('link', {
		name: 'Secrets',
		exact: true,
	})
	// Both render-prefetch and intent-prefetch must reuse a warmed payload.
	await secretsLink.hover()
	await expect.poll(() => docRequests.forDoc('secrets').length).toBe(1)

	await observeMainTransitions(page)
	await secretsLink.click()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()

	expectSingleCommitTransition(await readMainTransitions(page), {
		fromHeading: 'Shared memory',
		toHeading: 'Secrets',
	})
	// Wait through a possible post-commit fetch before checking the count.
	await page.waitForTimeout(250)
	expect(docRequests.forDoc('secrets')).toHaveLength(1)
	expect(docRequests.duplicates(), docRequests.paths.join(', ')).toEqual([])
})

test('docs site: header says Docs, /docs opens the introduction with a sidebar, and legacy /guides redirects', async ({
	page,
	request,
}) => {
	await page.context().clearCookies()

	await page.goto('/')
	const headerDocs = page
		.getByRole('navigation', { name: 'Main' })
		.getByRole('link', { name: 'Docs', exact: true })
	await expect(headerDocs).toBeVisible()
	await headerDocs.click()
	await expect(page).toHaveURL(/\/docs$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'What is Kody?' }),
	).toBeVisible()

	// The sidebar carries the whole reading order and marks the current page.
	const sidebar = page.getByRole('navigation', { name: 'Docs' }).first()
	await expect(sidebar).toBeVisible()
	await expect(
		sidebar.getByRole('link', { name: 'What is Kody?', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(
		sidebar.getByRole('link', { name: 'Shared memory', exact: true }),
	).toBeVisible()

	// In-app navigation to another doc keeps the shell and updates the head.
	await sidebar.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/docs\/secrets$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()
	await expect(page).toHaveTitle(/Secrets — Kody Docs/)
	await expect(
		sidebar.getByRole('link', { name: 'Secrets', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	// Previous / next follow the docs order.
	const pager = page.getByRole('navigation', { name: 'Docs order' })
	await expect(pager.getByRole('link', { name: /Previous/ })).toHaveAttribute(
		'href',
		/\/docs\//,
	)
	await expect(pager.getByRole('link', { name: /Next/ })).toHaveAttribute(
		'href',
		/\/docs\//,
	)

	// Provider index sits inside the same shell.
	await sidebar
		.getByRole('link', { name: 'Connect a provider', exact: true })
		.click()
	await expect(page).toHaveURL(/\/docs\/connect$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Connect a provider' }),
	).toBeVisible()
	await expect(page.getByRole('link', { name: /Connect GitHub/ })).toBeVisible()

	// Old bookmarks keep resolving.
	const legacy = await request.get('/guides/oauth', { maxRedirects: 0 })
	expect(legacy.status()).toBe(308)
	expect(legacy.headers()['location']).toBe('/docs/oauth')
	const legacyMarkdown = await request.get('/guides/what-is-kody.md', {
		maxRedirects: 0,
	})
	expect(legacyMarkdown.status()).toBe(308)
	expect(legacyMarkdown.headers()['location']).toBe('/docs/what-is-kody.md')
	const merged = await request.get(
		'/guides/integration-backed-app-happy-path',
		{ maxRedirects: 0 },
	)
	expect(merged.status()).toBe(308)
	expect(merged.headers()['location']).toBe(
		'/docs/package-apps#after-an-integration-smoke-test',
	)

	// Agent-facing twins.
	const markdown = await request.get('/docs/secrets.md')
	expect(markdown.status()).toBe(200)
	expect(markdown.headers()['content-type']).toContain('text/markdown')
	expect(await markdown.text()).toContain('# Secrets')
	const llms = await request.get('/llms.txt')
	expect(llms.status()).toBe(200)
	expect(await llms.text()).toContain('/docs/secrets.md')
	expect(await llms.text()).not.toContain('/docs/admin-events.md')

	await expect(
		sidebar.getByRole('link', { name: 'Admin events', exact: true }),
	).toHaveCount(0)
	await expect(sidebar.getByRole('heading', { name: 'Admin' })).toHaveCount(0)

	const adminDoc = await request.get('/docs/admin-events')
	expect(adminDoc.status()).toBe(404)
	expect(await adminDoc.text()).not.toContain('fleet.entitlement.crossed')
	const adminMarkdown = await request.get('/docs/admin-events.md')
	expect(adminMarkdown.status()).toBe(404)
	expect(await adminMarkdown.text()).toBe('# Doc not found\n')
	const subscriptions = await request.get('/docs/package-subscriptions.md')
	expect(subscriptions.status()).toBe(200)
	expect(await subscriptions.text()).toContain('run.error.recorded')
})

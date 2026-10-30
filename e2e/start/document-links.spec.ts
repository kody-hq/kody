import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { type Page } from '@playwright/test'

// Start prunes server-only routes from the client route tree, so a link to
// one used to fall through to an app route (e.g. `/docs/$slug`) and render a
// client-side 404 until the reader refreshed.
async function clickExpectingDocumentLoad(page: Page, href: string) {
	const navigation = page.waitForRequest(
		(request) =>
			request.isNavigationRequest() && new URL(request.url()).pathname === href,
	)
	await page.locator(`a[href="${href}"]`).click()
	await navigation
}

test('doc markdown link loads the markdown document on the first click', async ({
	page,
}) => {
	await page.goto('/docs')
	await waitForClientHydration(page)
	await page.locator('a[href="/docs/local-execute"]').first().click()
	await expect(page).toHaveURL(/\/docs\/local-execute$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Local CLI execute' }),
	).toBeVisible()

	await clickExpectingDocumentLoad(page, '/docs/local-execute.md')
	await expect(page).toHaveURL(/\/docs\/local-execute\.md$/)
	await expect(page.locator('body')).toContainText('# Local CLI execute')
})

test('blog RSS link leaves the app for the feed document', async ({ page }) => {
	await page.goto('/blog')
	await waitForClientHydration(page)
	await clickExpectingDocumentLoad(page, '/blog/rss.xml')
})

import { expect, test } from '../playwright-utils.ts'

test('About and Contact render native public documents with metadata and footer navigation', async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	})
	try {
		const page = await context.newPage()
		for (const [path, heading] of [
			['/about', 'About Kody'],
			['/contact', 'Contact Kody'],
		]) {
			const response = await page.goto(path!)
			expect(response?.status()).toBe(200)
			await expect(
				page.getByRole('heading', { name: heading!, exact: true }),
			).toBeVisible()
			await expect(page).toHaveTitle(new RegExp(heading!))
			await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
				'href',
				new RegExp(`${path}$`),
			)
			for (const [label, href] of [
				['About', '/about'],
				['Contact', '/contact'],
			]) {
				await expect(
					page
						.getByRole('navigation', { name: 'Footer' })
						.getByRole('link', { name: label!, exact: true }),
				).toHaveAttribute('href', href!)
			}
		}
		await expect(
			page.getByRole('link', { name: 'support@kody.codes', exact: true }),
		).toHaveAttribute('href', 'mailto:support@kody.codes')
	} finally {
		await context.close()
	}
})

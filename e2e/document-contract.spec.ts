import { expect, test } from './playwright-utils.ts'

test('public documents render complete content without JavaScript and preserve error statuses', async ({
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
			['/', /.+/],
			['/pricing', /Start free/],
			['/faq', /Questions.*before you connect/s],
			['/docs', /What is Kody/],
			['/privacy', /^Privacy$/],
		] as const) {
			const response = await page.goto(path)
			expect(response?.status(), path).toBe(200)
			if (path === '/') {
				expect(response?.headers()['link']).toContain(
					'/.well-known/mcp/server-card.json',
				)
				expect(response?.headers()['vary']?.toLowerCase()).toContain('accept')
			}
			expect(await response!.text(), path).toContain('</html>')
			await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
			await expect(page.getByRole('contentinfo')).toBeVisible()
			await expect(page).toHaveTitle(/.+/)
		}
		for (const [path, status, testId] of [
			['/docs/this-document-does-not-exist', 404, 'not-found-page'],
			['/ACCOUNT/JOBS', 404, 'not-found-page'],
			['/500', 500, 'internal-error-page'],
		] as const) {
			const response = await page.goto(path)
			expect(response?.status(), path).toBe(status)
			await expect(page.getByTestId(testId)).toBeVisible()
		}
		const unsupported = await context.request.post('/pricing')
		expect(unsupported.status()).toBe(405)
		expect(unsupported.headers()['allow']).toContain('GET')
	} finally {
		await context.close()
	}
})

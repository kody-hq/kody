import { expect, test } from './playwright-utils.ts'

test('removed blog posts return the native 404 document without a redirect', async ({
	page,
}) => {
	const response = await page.request.get('/blog/kody-vs-executor', {
		maxRedirects: 0,
	})
	expect(response.status()).toBe(404)
	expect(response.headers().location).toBeUndefined()
	expect(response.headers()['cache-control']).toContain('no-store')
	expect(response.headers()['content-security-policy']).toMatch(
		/script-src[^;]*'nonce-[^']+'/,
	)
	expect(await response.text()).toContain('data-testid="not-found-page"')
})

import { randomUUID } from 'node:crypto'
import { expect, test } from '../playwright-utils.ts'

for (const pathname of ['/@topup-return-user/-/usage', '/account/usage']) {
	test(`anonymous credit return preserves login destination at ${pathname}`, async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ baseURL })
		try {
			const page = await context.newPage()
			await page.goto(`${pathname}?topup=success&session_id=cs_no_payment`)
			await expect(page).toHaveURL(/\/login\?/)
			const destination = new URL(page.url()).searchParams.get('redirectTo')
			expect(destination).toBeTruthy()
			const returnUrl = new URL(destination!, baseURL)
			expect(returnUrl.pathname).toBe(pathname)
			expect(returnUrl.searchParams.get('topup')).toBe('success')
			expect(returnUrl.searchParams.get('session_id')).toBe('cs_no_payment')
		} finally {
			await context.close()
		}
	})

	test(`credit return HEAD cannot complete payment at ${pathname}`, async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ baseURL })
		try {
			const response = await context.request.head(
				`${pathname}?topup=success&session_id=cs_no_payment`,
				{ maxRedirects: 0 },
			)
			expect(response.status()).toBe(405)
			const ordinary = await context.request.head(pathname, { maxRedirects: 0 })
			expect(ordinary.status()).not.toBe(405)
			expect(ordinary.status()).toBeLessThan(500)
		} finally {
			await context.close()
		}
	})
}

test('signed-in invalid credit return becomes a clean usage error redirect', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `topup-${id}@example.com`,
		username: `topup-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto(
		`/@${user.username}/-/usage?topup=success&session_id=cs_nonexistent_${id}`,
	)
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/usage\\?error=[^#]+#credits$`),
	)
	expect(new URL(page.url()).searchParams.has('session_id')).toBe(false)
	expect(new URL(page.url()).searchParams.has('topup')).toBe(false)
})

import { randomUUID } from 'node:crypto'
import { isBlackFridayActive } from '../../packages/worker/start/campaigns/black-friday-2026/offer.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('a checkout link asks for sign-in, then sends the owner to Stripe with the sale applied', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.skip(
		Boolean(process.env.PLAYWRIGHT_BASE_URL),
		'Requires the isolated E2E Stripe simulator',
	)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `checkout-link-${id}@example.com`,
		username: `checkout-link-${id}`,
	})
	const link = `/@${user.username}/-/billing/checkout?plan=pro&interval=year`

	await page.goto(link)
	await expect(page).toHaveURL(/\/login\?/)
	expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(link)

	await login({ ...user, mode: 'login' })
	await page.goto(link)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Check out Pro' }),
	).toBeVisible()
	const onSale = isBlackFridayActive(Date.now())
	if (onSale) {
		await expect(
			page.getByText(
				'Black Friday price: annual Pro is $90 for the first year, normally $120.',
			),
		).toBeVisible()
	}
	await expect(page.getByText(/BLACKFRIDAY/i)).toHaveCount(0)
	await page.getByRole('button', { name: 'Continue to Stripe' }).click()
	await expect(
		page.getByRole('heading', { name: 'Test checkout' }),
	).toBeVisible()
	await expect(
		page.getByText(onSale ? 'Discount: promo_e2e_year' : 'No discount'),
	).toBeVisible()
})

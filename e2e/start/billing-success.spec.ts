import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { requestHasMutationDataFields } from '../server-function-requests.ts'

test('subscription checkout, portal return, and credit payment persist through real Start operations', async ({
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
		email: `billing-${id}@example.com`,
		username: `billing-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const billing = `/@${user.username}/-/billing`
	const usage = `/@${user.username}/-/usage`
	await page.goto(billing)
	await waitForClientHydration(page)
	const checkoutResponse = page.waitForResponse((response) =>
		requestHasMutationDataFields(response.request(), {
			orgSlug: user.username,
			plan: 'pro',
			interval: 'month',
		}),
	)
	await page
		.getByRole('button', { name: 'Subscribe monthly', exact: true })
		.click()
	const response = await checkoutResponse
	expect(response.ok(), `Checkout returned HTTP ${response.status()}`).toBe(
		true,
	)
	await expect(
		page.getByRole('heading', { name: 'Test checkout' }),
	).toBeVisible()
	expect(new URL(page.url()).hostname).toBe('127.0.0.1')
	await page.getByRole('button', { name: 'Complete test payment' }).click()
	await expect(page).toHaveURL(/\/billing\/success\?session_id=cs_/)
	await expect(page.getByRole('heading', { name: 'You’re in' })).toBeVisible()
	// Completion links the customer and reconciles the real org subscription.
	await page.goto(billing)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('button', { name: 'Current plan', exact: true }),
	).toBeVisible()
	await page
		.getByRole('button', { name: 'Manage subscription', exact: true })
		.click()
	await expect(
		page.getByRole('heading', { name: 'Test billing portal' }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Return to Kody' }).click()
	await expect(page).toHaveURL(new RegExp(`${billing}$`))
	await page.goto(usage)
	await waitForClientHydration(page)
	const balance = page.locator('[data-credits-balance]')
	await expect(balance).toBeVisible()
	const before = Number((await balance.innerText()).replace(/[^\d.-]/g, ''))
	await page.getByRole('button', { name: '$10', exact: true }).click()
	await expect(
		page.getByRole('heading', { name: 'Test checkout' }),
	).toBeVisible()
	const checkout = page.url()
	const sessionId = new URL(checkout).pathname.split('/').at(-1)!
	await page.getByRole('button', { name: 'Complete test payment' }).click()
	await expect(page).toHaveURL(new RegExp(`${usage}\\?credits=added#credits$`))
	await expect
		.poll(async () =>
			Number((await balance.innerText()).replace(/[^\d.-]/g, '')),
		)
		.toBe(before + 10)
	await expect(page.locator('[data-credits-ledger-kind="top_up"]')).toHaveCount(
		1,
	)
	await page.reload()
	await expect
		.poll(async () =>
			Number((await balance.innerText()).replace(/[^\d.-]/g, '')),
		)
		.toBe(before + 10)
	// Replaying the provider return goes through the real signed attribution and wallet write.
	await page.goto(`${usage}?topup=success&session_id=${sessionId}`)
	await expect(page).toHaveURL(new RegExp(`${usage}\\?credits=added#credits$`))
	await expect
		.poll(async () =>
			Number((await balance.innerText()).replace(/[^\d.-]/g, '')),
		)
		.toBe(before + 10)
	await expect(page.locator('[data-credits-ledger-kind="top_up"]')).toHaveCount(
		1,
	)
})

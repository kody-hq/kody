import { expect, test } from 'vitest'
import { startStripeMock } from './stripe-mock-server.ts'

test('Stripe simulator requires its disposable API token and only pays through hosted checkout', async () => {
	const mock = await startStripeMock()
	try {
		const endpoint = `${mock.origin}/v1/checkout/sessions`
		expect((await fetch(endpoint)).status).toBe(401)
		const headers = { authorization: `Bearer ${mock.token}` }
		const response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: new URLSearchParams({
				mode: 'payment',
				success_url:
					'http://localhost:3847/return?session_id={CHECKOUT_SESSION_ID}',
				cancel_url: 'http://localhost:3847/',
				client_reference_id: 'signed-reference',
				'metadata[kody_credit_top_up]': '1',
				'line_items[0][price_data][unit_amount]': '1000',
			}),
		})
		const session = (await response.json()) as { id: string; url: string }
		expect(response.status).toBe(200)
		const read = async () =>
			(await fetch(`${endpoint}/${session.id}`, { headers })).json()
		expect(await read()).toMatchObject({
			payment_status: 'unpaid',
			client_reference_id: 'signed-reference',
			metadata: { kody_credit_top_up: '1' },
		})
		const paid = await fetch(session.url, {
			method: 'POST',
			redirect: 'manual',
		})
		expect(paid.status).toBe(303)
		expect(paid.headers.get('location')).toBe(
			`http://localhost:3847/return?session_id=${session.id}`,
		)
		expect(await read()).toMatchObject({
			payment_status: 'paid',
			amount_total: 1000,
		})
	} finally {
		await mock.close()
	}
})

test('Stripe simulator refuses external checkout and portal return destinations', async () => {
	const mock = await startStripeMock()
	try {
		const headers = { authorization: `Bearer ${mock.token}` }
		for (const key of ['success_url', 'cancel_url']) {
			const body = new URLSearchParams({
				success_url: 'http://localhost:3847/return',
				cancel_url: 'http://localhost:3847/',
			})
			body.set(key, 'https://kody.codes/account/billing')
			expect(
				(
					await fetch(`${mock.origin}/v1/checkout/sessions`, {
						method: 'POST',
						headers,
						body,
					})
				).status,
			).toBe(400)
		}
		expect(
			(
				await fetch(`${mock.origin}/v1/billing_portal/sessions`, {
					method: 'POST',
					headers,
					body: new URLSearchParams({ return_url: 'https://kody.codes/' }),
				})
			).status,
		).toBe(400)
	} finally {
		await mock.close()
	}
})

test('simulated provider responses satisfy the real subscription and credit parsers', async () => {
	const {
		createCheckoutSession,
		getCheckoutSession,
		listSubscriptions,
		mergeStripeObjectMetadata,
		createBillingPortalSession,
		createCreditTopUpCheckoutSession,
		getCreditTopUpCheckoutSession,
	} = await import('../packages/worker/src/billing/stripe-client.ts')
	const mock = await startStripeMock()
	const env = {
		STRIPE_SECRET_KEY: mock.token,
		STRIPE_API_BASE_URL: mock.origin,
	}
	const successUrl =
		'http://localhost:3847/return?session_id={CHECKOUT_SESSION_ID}'
	const cancelUrl = 'http://localhost:3847/'
	try {
		const subscription = await createCheckoutSession(env, {
			priceId: 'price_pro',
			clientReferenceId: 'signed-reference',
			successUrl,
			cancelUrl,
			metadata: { kody_org_id: 'test-org' },
		})
		await fetch(subscription.url, { method: 'POST', redirect: 'manual' })
		const session = await getCheckoutSession(env, subscription.id)
		expect(session).toMatchObject({
			client_reference_id: 'signed-reference',
			metadata: { kody_org_id: 'test-org' },
		})
		const customerId = session.customer!
		await mergeStripeObjectMetadata(env, {
			object: 'customers',
			id: customerId,
			metadata: { kody_org_id: 'test-org' },
		})
		expect(await listSubscriptions(env, customerId)).toMatchObject([
			{
				status: 'active',
				items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] },
			},
		])
		const portal = await createBillingPortalSession(env, {
			customerId,
			returnUrl: cancelUrl,
		})
		expect(
			(
				await fetch(portal.url, { method: 'POST', redirect: 'manual' })
			).headers.get('location'),
		).toBe(cancelUrl)
		const credit = await createCreditTopUpCheckoutSession(env, {
			customerId,
			amountCents: 1000,
			clientReferenceId: 'signed-reference',
			successUrl,
			cancelUrl,
			metadata: { kody_credit_top_up: '1', kody_org_id: 'test-org' },
		})
		await fetch(credit.url, { method: 'POST', redirect: 'manual' })
		expect(await getCreditTopUpCheckoutSession(env, credit.id)).toMatchObject({
			mode: 'payment',
			status: 'complete',
			payment_status: 'paid',
			amount_total: 1000,
			currency: 'usd',
			customer: customerId,
			client_reference_id: 'signed-reference',
			metadata: { kody_credit_top_up: '1' },
			payment_intent: { payment_method: expect.any(String) },
		})
	} finally {
		await mock.close()
	}
})

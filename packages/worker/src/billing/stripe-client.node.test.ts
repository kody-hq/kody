import { expect, test, vi, type Mock } from 'vitest'
import {
	consoleError,
	silenceExpectedConsoleErrors,
} from '#worker/test-support/console-spies.ts'
import {
	accountDeletionCreditNoteMemo,
	BillingNotConfiguredError,
	cancelSubscription,
	createBillingPortalSession,
	createCheckoutSession,
	createCreditTopUpCheckoutSession,
	createOffSessionPaymentIntent,
	createProratedRefundCreditNote,
	creditNoteCapFitAttempts,
	creditNoteListMaxPages,
	deleteCustomer,
	findActivePromotionCode,
	getCheckoutSession,
	getCreditTopUpCheckoutSession,
	isAccountDeletionCreditNote,
	isStripeIdempotencyParameterMismatchError,
	isStripeNothingToRefundError,
	listCreditNotesForCustomer,
	listPaymentIntentsForCustomer,
	listCreditNotesForInvoice,
	listPaidInvoicesForSubscription,
	listSubscriptions,
	mergeStripeObjectMetadata,
	StripeApiError,
} from './stripe-client.ts'

const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
const checkoutInput = {
	priceId: 'price_pro',
	clientReferenceId: 'signed-ref',
	successUrl:
		'https://app.example.com/@ada/-/billing/success?session_id={CHECKOUT_SESSION_ID}',
	cancelUrl: 'https://app.example.com/@ada/-/billing',
	customerEmail: 'user@example.com',
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function stubFetch<T extends Mock>(fetchMock: T) {
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

function fetchReturning(...responses: Array<Response>) {
	const fetchMock = vi.fn()
	for (const response of responses) fetchMock.mockResolvedValueOnce(response)
	return stubFetch(fetchMock)
}

/** Reads the named form fields off a request body (`null` when absent). */
function formFields(init: unknown, keys: Array<string>) {
	const body = new URLSearchParams(String((init as RequestInit)?.body))
	return Object.fromEntries(keys.map((key) => [key, body.get(key)]))
}

function formOf(init: unknown) {
	return Object.fromEntries(
		new URLSearchParams((init as RequestInit).body as string),
	)
}

function queryOf(url: unknown) {
	return Object.fromEntries(new URL(url as string).searchParams)
}

async function expectStripeError(promise: Promise<unknown>, status: number) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(error).toBeInstanceOf(StripeApiError)
	expect((error as StripeApiError).status).toBe(status)
	return error as StripeApiError
}

test('stripe client request contracts for checkout, subscriptions, and portal', async () => {
	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_test_1',
				customer: 'cus_123',
				client_reference_id: 'user-stable-id',
			}),
		)
		expect(await getCheckoutSession(env, 'cs_test_1')).toEqual({
			id: 'cs_test_1',
			customer: 'cus_123',
			client_reference_id: 'user-stable-id',
		})
		expect(fetchMock.mock.calls).toEqual([
			[
				'https://api.stripe.com/v1/checkout/sessions/cs_test_1',
				expect.objectContaining({
					method: 'GET',
					headers: expect.objectContaining({
						authorization: 'Bearer sk_test_secret',
						accept: 'application/json',
					}),
				}),
			],
		])
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_new_1',
				url: 'https://checkout.stripe.com/c/pay/cs_new_1',
			}),
		)
		expect(await createCheckoutSession(env, checkoutInput)).toEqual({
			id: 'cs_new_1',
			url: 'https://checkout.stripe.com/c/pay/cs_new_1',
		})
		expect(fetchMock).toHaveBeenCalledOnce()
		const [createUrl, createInit] = fetchMock.mock.calls[0]!
		expect(createUrl).toBe('https://api.stripe.com/v1/checkout/sessions')
		expect(createInit?.method).toBe('POST')
		expect(createInit?.headers).toMatchObject({
			authorization: 'Bearer sk_test_secret',
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		})
		const expected = {
			mode: 'subscription',
			'line_items[0][price]': 'price_pro',
			'line_items[0][quantity]': '1',
			client_reference_id: 'signed-ref',
			success_url: checkoutInput.successUrl,
			cancel_url: 'https://app.example.com/@ada/-/billing',
			customer_email: 'user@example.com',
			customer: null,
			'automatic_tax[enabled]': 'true',
			'tax_id_collection[enabled]': 'true',
			// Kody validates promo codes itself (monthly only); Stripe's code
			// box would let one-month codes apply to annual.
			allow_promotion_codes: null,
			'discounts[0][promotion_code]': null,
			'customer_update[address]': null,
			'customer_update[name]': null,
		}
		expect(formFields(createInit, Object.keys(expected))).toEqual(expected)
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_seats',
				url: 'https://checkout.stripe.com/c/pay/cs_seats',
			}),
		)
		await createCheckoutSession(env, { ...checkoutInput, quantity: 3 })
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], ['line_items[0][quantity]']),
		).toEqual({ 'line_items[0][quantity]': '3' })
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_promo',
				url: 'https://checkout.stripe.com/c/pay/cs_promo',
			}),
		)
		await createCheckoutSession(env, {
			...checkoutInput,
			promotionCodeId: 'promo_agency_1',
		})
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], [
				'discounts[0][promotion_code]',
				'allow_promotion_codes',
			]),
		).toEqual({
			'discounts[0][promotion_code]': 'promo_agency_1',
			allow_promotion_codes: null,
		})
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_meta',
				url: 'https://checkout.stripe.com/c/pay/cs_meta',
			}),
		)
		await createCheckoutSession(env, {
			...checkoutInput,
			metadata: {
				kody_org_id: 'org-acme',
				kody_stable_user_id: 'org-acme',
				kody_plan: 'pro',
			},
		})
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], [
				'metadata[kody_org_id]',
				'metadata[kody_stable_user_id]',
				'metadata[kody_plan]',
				'subscription_data[metadata][kody_org_id]',
				'subscription_data[metadata][kody_stable_user_id]',
				'subscription_data[metadata][kody_plan]',
			]),
		).toEqual({
			'metadata[kody_org_id]': 'org-acme',
			'metadata[kody_stable_user_id]': 'org-acme',
			'metadata[kody_plan]': 'pro',
			'subscription_data[metadata][kody_org_id]': 'org-acme',
			'subscription_data[metadata][kody_stable_user_id]': 'org-acme',
			'subscription_data[metadata][kody_plan]': 'pro',
		})
	}

	{
		using fetchMock = fetchReturning(jsonResponse({ id: 'cus_1' }))
		await mergeStripeObjectMetadata(env, {
			object: 'customers',
			id: 'cus_1',
			metadata: { kody_org_id: 'org-acme' },
		})
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://api.stripe.com/v1/customers/cus_1')
		expect(init?.method).toBe('POST')
		expect(formFields(init, ['metadata[kody_org_id]'])).toEqual({
			'metadata[kody_org_id]': 'org-acme',
		})
	}

	// Existing Stripe customers must send customer, never customer_email.
	{
		using fetchMock = fetchReturning(
			jsonResponse({
				id: 'cs_new_2',
				url: 'https://checkout.stripe.com/c/pay/cs_new_2',
			}),
		)
		await createCheckoutSession(env, {
			...checkoutInput,
			customerId: 'cus_existing',
			customerEmail: 'should-not-send@example.com',
		})
		const expected = {
			customer: 'cus_existing',
			customer_email: null,
			'customer_update[address]': 'auto',
			'customer_update[name]': 'auto',
			'automatic_tax[enabled]': 'true',
		}
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], Object.keys(expected)),
		).toEqual(expected)
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({
				data: [
					{
						id: 'sub_1',
						status: 'active',
						cancel_at: null,
						items: { data: [{ price: { id: 'price_1' } }] },
					},
				],
			}),
		)
		const subscriptions = await listSubscriptions(
			{ ...env, STRIPE_API_BASE_URL: 'https://stripe.mock/' },
			'cus_abc',
		)
		expect(subscriptions.map((subscription) => subscription.id)).toEqual([
			'sub_1',
		])
		const [listUrl, listInit] = fetchMock.mock.calls[0]!
		const parsed = new URL(String(listUrl))
		expect(parsed.origin + parsed.pathname).toBe(
			'https://stripe.mock/v1/subscriptions',
		)
		expect(queryOf(listUrl)).toMatchObject({
			customer: 'cus_abc',
			status: 'all',
			limit: '100',
		})
		expect(listInit).toMatchObject({
			method: 'GET',
			headers: expect.objectContaining({
				authorization: 'Bearer sk_test_secret',
			}),
		})
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({ url: 'https://billing.stripe.com/session/test' }),
		)
		expect(
			await createBillingPortalSession(env, {
				customerId: 'cus_portal',
				returnUrl: 'https://app.example.com/account',
			}),
		).toEqual({ url: 'https://billing.stripe.com/session/test' })
		const [portalUrl, portalInit] = fetchMock.mock.calls[0]!
		expect(portalUrl).toBe('https://api.stripe.com/v1/billing_portal/sessions')
		expect(portalInit?.method).toBe('POST')
		expect(portalInit?.headers).toMatchObject({
			authorization: 'Bearer sk_test_secret',
			'content-type': 'application/x-www-form-urlencoded',
		})
		// Plain portal: no configuration pin and no deep-link flow.
		const expected = {
			customer: 'cus_portal',
			return_url: 'https://app.example.com/account',
			configuration: null,
			'flow_data[type]': null,
		}
		expect(formFields(portalInit, Object.keys(expected))).toEqual(expected)
	}

	// Switching an existing subscriber to Pro opens the portal on the
	// confirm step pinned to the Pro price, with the Kody configuration.
	const flowData = {
		type: 'subscription_update_confirm' as const,
		subscriptionId: 'sub_current',
		subscriptionItemId: 'si_current',
		priceId: 'price_pro',
		afterCompletionRedirectUrl:
			'https://app.example.com/account/billing?billing=updated',
	}
	{
		using fetchMock = fetchReturning(
			jsonResponse({ url: 'https://billing.stripe.com/session/flow' }),
		)
		expect(
			await createBillingPortalSession(env, {
				customerId: 'cus_portal',
				returnUrl: 'https://app.example.com/account/billing',
				configuration: ' bpc_kody ',
				flowData,
			}),
		).toEqual({ url: 'https://billing.stripe.com/session/flow' })
		const confirm = 'flow_data[subscription_update_confirm]'
		const expected = {
			customer: 'cus_portal',
			return_url: 'https://app.example.com/account/billing',
			configuration: 'bpc_kody',
			'flow_data[type]': 'subscription_update_confirm',
			[`${confirm}[subscription]`]: 'sub_current',
			[`${confirm}[items][0][id]`]: 'si_current',
			[`${confirm}[items][0][price]`]: 'price_pro',
			[`${confirm}[items][0][quantity]`]: '1',
			'flow_data[after_completion][type]': 'redirect',
			'flow_data[after_completion][redirect][return_url]':
				'https://app.example.com/account/billing?billing=updated',
		}
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], Object.keys(expected)),
		).toEqual(expected)
	}

	{
		using fetchMock = fetchReturning(
			jsonResponse({ url: 'https://billing.stripe.com/session/seats' }),
		)
		await createBillingPortalSession(env, {
			customerId: 'cus_portal',
			returnUrl: 'https://app.example.com/account/billing',
			configuration: 'bpc_kody',
			flowData: { ...flowData, quantity: 4 },
		})
		const confirm = 'flow_data[subscription_update_confirm]'
		expect(
			formFields(fetchMock.mock.calls[0]?.[1], [
				`${confirm}[items][0][quantity]`,
			]),
		).toEqual({ [`${confirm}[items][0][quantity]`]: '4' })
	}

	{
		using fetchMock = stubFetch(vi.fn())
		await expect(
			createBillingPortalSession(env, {
				customerId: 'cus_portal',
				returnUrl: 'https://app.example.com/account/billing',
				flowData: { ...flowData, subscriptionId: '   ' },
			}),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
		expect(fetchMock).not.toHaveBeenCalled()
	}
})

test('stripe client immediately cancels subscriptions and deletes customers', async () => {
	using fetchMock = fetchReturning(
		jsonResponse({ id: 'sub_active', status: 'canceled' }),
		jsonResponse({ id: 'cus_delete', deleted: true }),
	)
	await cancelSubscription(env, 'sub_active')
	await deleteCustomer(env, 'cus_delete')
	expect(fetchMock.mock.calls).toEqual([
		[
			'https://api.stripe.com/v1/subscriptions/sub_active',
			expect.objectContaining({ method: 'DELETE' }),
		],
		[
			'https://api.stripe.com/v1/customers/cus_delete',
			expect.objectContaining({ method: 'DELETE' }),
		],
	])

	consoleError.mockImplementation(() => {})
	fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
	await expect(
		deleteCustomer(env, 'cus_sensitive_identifier'),
	).rejects.toBeInstanceOf(StripeApiError)
	expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
		status: 503,
		path: '/v1/customers/<redacted>',
	})
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
		'cus_sensitive_identifier',
	)

	// Canceling a subscription Stripe no longer knows is idempotent success;
	// any other API failure still surfaces with its Stripe error code.
	fetchMock.mockResolvedValueOnce(
		jsonResponse(
			{
				error: {
					code: 'resource_missing',
					message: 'No such subscription: sub_gone',
				},
			},
			404,
		),
	)
	await expect(cancelSubscription(env, 'sub_gone')).resolves.toBeUndefined()
	fetchMock.mockResolvedValueOnce(
		jsonResponse(
			{ error: { code: 'rate_limit', message: 'Too many requests' } },
			429,
		),
	)
	await expect(cancelSubscription(env, 'sub_busy')).rejects.toMatchObject({
		name: 'StripeApiError',
		status: 429,
		code: 'rate_limit',
	})
})

test('stripe client reads recent paid invoices and credit notes for a subscription and customer', async () => {
	const kodyNote = {
		id: 'cn_kody',
		invoice: 'in_latest',
		total: 300,
		currency: 'usd',
		status: 'issued',
		metadata: {
			kody_account_deletion: '1',
			kody_subscription_id: 'sub_paid',
		},
	}
	using fetchMock = fetchReturning(
		jsonResponse({
			object: 'list',
			data: [
				{
					id: 'in_latest',
					object: 'invoice',
					amount_paid: 600,
					amount_due: 600,
					currency: 'usd',
					lines: {
						object: 'list',
						data: [
							{
								id: 'il_latest',
								object: 'line_item',
								amount: 1200,
								description: 'Pro (monthly)',
								discount_amounts: [{ amount: 600, discount: 'di_promo' }],
								period: { start: 1_756_684_800, end: 1_759_276_800 },
							},
						],
					},
				},
			],
		}),
		jsonResponse({ object: 'list', data: [] }),
		jsonResponse({
			object: 'list',
			has_more: false,
			data: [
				{
					...kodyNote,
					object: 'credit_note',
					memo: accountDeletionCreditNoteMemo,
				},
			],
		}),
		jsonResponse({ object: 'list', has_more: false, data: [] }),
	)
	// The gross line amount and its discounts are both visible; the
	// customer paid 600 for a 1200 line.
	expect(await listPaidInvoicesForSubscription(env, 'sub_paid')).toEqual([
		{
			id: 'in_latest',
			amount_paid: 600,
			currency: 'usd',
			lines: {
				data: [
					{
						id: 'il_latest',
						amount: 1200,
						discount_amounts: [{ amount: 600 }],
						period: { start: 1_756_684_800, end: 1_759_276_800 },
					},
				],
			},
		},
	])
	// A trial that has not converted has no paid invoice at all.
	await expect(
		listPaidInvoicesForSubscription(env, 'sub_trial'),
	).resolves.toEqual([])

	const creditNotes = await listCreditNotesForInvoice(env, 'in_latest')
	expect(creditNotes).toEqual([kodyNote])
	expect(creditNotes.every(isAccountDeletionCreditNote)).toBe(true)
	await expect(listCreditNotesForCustomer(env, 'cus_paid')).resolves.toEqual([])
	expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
		'https://api.stripe.com/v1/invoices?subscription=sub_paid&status=paid&limit=10',
		'https://api.stripe.com/v1/invoices?subscription=sub_trial&status=paid&limit=10',
		'https://api.stripe.com/v1/credit_notes?invoice=in_latest&limit=100',
		'https://api.stripe.com/v1/credit_notes?customer=cus_paid&limit=100',
	])
	expect(
		fetchMock.mock.calls.filter(([, init]) => init?.method !== 'GET'),
	).toEqual([])

	// Only an issued note carrying the metadata marker is Kody's; the memo
	// alone proves nothing because support can reuse the same text.
	for (const note of [
		{ status: 'void', metadata: { kody_account_deletion: '1' } },
		{ status: 'issued', metadata: {} as Record<string, string> },
	]) {
		expect(
			isAccountDeletionCreditNote({ ...kodyNote, total: 600, ...note }),
		).toBe(false)
	}
})

function creditNotePage(ids: Array<string>, invoice: string, hasMore: boolean) {
	return jsonResponse({
		object: 'list',
		has_more: hasMore,
		data: ids.map((id) => ({
			id,
			object: 'credit_note',
			invoice,
			total: 100,
			currency: 'usd',
			status: 'issued',
			metadata: {},
		})),
	})
}

test('stripe client follows credit note pagination to the end and refuses an endless listing', async () => {
	// Per invoice: three pages, each requested from the previous page's last
	// id, so an invoice with more than 100 credit notes is never under-counted
	// (that under-count would over-refund).
	{
		using fetchMock = fetchReturning(
			creditNotePage(['cn_1', 'cn_2'], 'in_1', true),
			creditNotePage(['cn_3', 'cn_4'], 'in_1', true),
			creditNotePage(['cn_5'], 'in_1', false),
		)
		const forInvoice = await listCreditNotesForInvoice(env, 'in_1')
		expect(forInvoice.map((creditNote) => creditNote.id)).toEqual([
			'cn_1',
			'cn_2',
			'cn_3',
			'cn_4',
			'cn_5',
		])
		expect(fetchMock.mock.calls.map(([url]) => queryOf(url))).toEqual([
			{ invoice: 'in_1', limit: '100' },
			{ invoice: 'in_1', limit: '100', starting_after: 'cn_2' },
			{ invoice: 'in_1', limit: '100', starting_after: 'cn_4' },
		])
	}

	// Per customer: same cursor walk, so the deletion report includes every
	// earlier Kody note, not just the first page.
	{
		using fetchMock = fetchReturning(
			creditNotePage(['cn_a'], 'in_a', true),
			creditNotePage(['cn_b'], 'in_b', false),
		)
		const forCustomer = await listCreditNotesForCustomer(env, 'cus_1')
		expect(forCustomer.map((creditNote) => creditNote.id)).toEqual([
			'cn_a',
			'cn_b',
		])
		expect(fetchMock.mock.calls.map(([url]) => queryOf(url))).toEqual([
			{ customer: 'cus_1', limit: '100' },
			{ customer: 'cus_1', limit: '100', starting_after: 'cn_a' },
		])
	}

	// A listing still reporting has_more after the page cap is not trusted
	// as complete: the caller learns it is incomplete rather than getting a
	// partial sum it would treat as the whole.
	{
		using fetchMock = stubFetch(
			vi.fn(async (url: string) => {
				const page = Number(queryOf(url).starting_after?.slice(3) ?? 0) + 1
				return creditNotePage([`cn_${page}`], 'in_endless', true)
			}),
		)
		await expect(
			listCreditNotesForInvoice(env, 'in_endless'),
		).rejects.toMatchObject({
			name: 'StripeCreditNoteListIncompleteError',
			status: 502,
			pages: creditNoteListMaxPages,
		})
		expect(fetchMock).toHaveBeenCalledTimes(creditNoteListMaxPages)
		expect(queryOf(fetchMock.mock.calls.at(-1)![0])).toEqual({
			invoice: 'in_endless',
			limit: '100',
			starting_after: `cn_${creditNoteListMaxPages - 1}`,
		})
	}

	// A list page without has_more is not a Stripe list.
	{
		using _fetchMock = fetchReturning(
			jsonResponse({ object: 'list', data: [] }),
		)
		await expect(
			listCreditNotesForCustomer(env, 'cus_1'),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 502 })
	}
})

function previewTotalling(total: number) {
	return jsonResponse({ object: 'credit_note', total, currency: 'usd' })
}

function lineAmountsOf(url: unknown) {
	return [...new URL(url as string).searchParams.entries()]
		.filter(([key]) => /^lines\[\d+\]\[amount\]$/.test(key))
		.map(([, value]) => Number(value))
}

function refund(
	lines: Array<{ invoiceLineItemId: string; amount: number }>,
	maxRefundMinor: number,
	invoiceId = 'in_upgrade',
) {
	return createProratedRefundCreditNote(env, {
		invoiceId,
		subscriptionId: 'sub_1',
		lines,
		maxRefundMinor,
		reason: 'order_change',
	})
}

test('stripe client previews then issues a prorated credit note that refunds the previewed total', async () => {
	using fetchMock = fetchReturning(
		jsonResponse({
			object: 'credit_note',
			total: 654,
			currency: 'usd',
			status: 'issued',
			memo: null,
		}),
		jsonResponse({
			id: 'cn_created',
			object: 'credit_note',
			invoice: 'in_latest',
			total: 654,
			currency: 'usd',
			status: 'issued',
			memo: accountDeletionCreditNoteMemo,
			metadata: { kody_account_deletion: '1', kody_subscription_id: 'sub_1' },
		}),
	)
	expect(
		await refund(
			[
				{ invoiceLineItemId: 'il_plan', amount: 600 },
				{ invoiceLineItemId: 'il_addon', amount: 250 },
			],
			1500,
			'in_latest',
		),
	).toEqual({
		outcome: 'issued',
		id: 'cn_created',
		total: 654,
		currency: 'usd',
	})

	expect(fetchMock).toHaveBeenCalledTimes(2)
	const [previewUrl, previewInit] = fetchMock.mock.calls[0]!
	expect(previewInit).toMatchObject({ method: 'GET' })
	const expectedLines = {
		invoice: 'in_latest',
		'lines[0][type]': 'invoice_line_item',
		'lines[0][invoice_line_item]': 'il_plan',
		'lines[0][amount]': '600',
		'lines[1][type]': 'invoice_line_item',
		'lines[1][invoice_line_item]': 'il_addon',
		'lines[1][amount]': '250',
	}
	expect(queryOf(previewUrl)).toEqual(expectedLines)
	expect(new URL(previewUrl as string).pathname).toBe(
		'/v1/credit_notes/preview',
	)

	const [createUrl, createInit] = fetchMock.mock.calls[1]!
	expect(createUrl).toBe('https://api.stripe.com/v1/credit_notes')
	expect(createInit).toMatchObject({
		method: 'POST',
		headers: expect.objectContaining({
			'content-type': 'application/x-www-form-urlencoded',
		}),
	})
	// The refund must equal the credit note total (line shares minus their
	// discounts plus their tax), which only the preview knows; the gross
	// line amounts are what Stripe prorates discounts and tax from.
	expect(formOf(createInit)).toEqual({
		...expectedLines,
		refund_amount: '654',
		reason: 'order_change',
		memo: accountDeletionCreditNoteMemo,
		'metadata[kody_account_deletion]': '1',
		'metadata[kody_subscription_id]': 'sub_1',
	})

	// A preview that totals zero (a fully discounted line) creates nothing.
	fetchMock.mockClear()
	fetchMock.mockResolvedValueOnce(previewTotalling(0))
	await expect(
		refund([{ invoiceLineItemId: 'il_free', amount: 600 }], 1200, 'in_free'),
	).resolves.toEqual({ outcome: 'nothing_to_refund' })
	expect(fetchMock).toHaveBeenCalledOnce()

	// Guard rails that never reach Stripe.
	fetchMock.mockClear()
	for (const [invoiceId, lines, maxRefundMinor] of [
		['in_latest', [{ invoiceLineItemId: 'il_1', amount: 0 }], 1200],
		[' ', [{ invoiceLineItemId: 'il_1', amount: 600 }], 1200],
		['in_latest', [{ invoiceLineItemId: ' ', amount: 600 }], 1200],
		['in_latest', [], 1200],
		['in_latest', [{ invoiceLineItemId: 'il_1', amount: 600 }], 0],
	] as const) {
		await expect(
			refund([...lines], maxRefundMinor, invoiceId),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
	}
	expect(fetchMock).not.toHaveBeenCalled()

	// Stripe's validation failures come back as a bare 400 with only a
	// message; they must be classifiable without leaking that message (which
	// can embed ids) into logs. Only an already-refunded charge counts as
	// "nothing to refund"; an amount mismatch is a real failure.
	consoleError.mockImplementation(() => {})
	fetchMock.mockResolvedValueOnce(
		jsonResponse(
			{
				error: {
					type: 'invalid_request_error',
					message: 'The charge for in_latest has already been fully refunded.',
				},
			},
			400,
		),
	)
	const alreadyRefunded = await expectStripeError(
		refund([{ invoiceLineItemId: 'il_plan', amount: 600 }], 1200, 'in_latest'),
		400,
	)
	expect(isStripeNothingToRefundError(alreadyRefunded)).toBe(true)
	expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
		status: 400,
		path: '/v1/credit_notes/preview',
	})
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain('in_latest')

	const classified = [
		[400, { code: 'charge_already_refunded' }, true],
		[
			400,
			{
				stripeMessage:
					'The credit note amount exceeds the maximum creditable amount for this invoice.',
			},
			false,
		],
		[400, { stripeMessage: 'Invalid integer: abc' }, false],
		[503, { stripeMessage: 'already refunded' }, false],
	] as const
	expect(
		classified.filter(
			([status, details, nothingToRefund]) =>
				isStripeNothingToRefundError(
					new StripeApiError(`Stripe API request failed with HTTP ${status}.`, {
						status,
						...details,
					}),
				) !== nothingToRefund,
		),
	).toEqual([])
	expect(isStripeNothingToRefundError(new Error('already refunded'))).toBe(
		false,
	)
})

test('isStripeIdempotencyParameterMismatchError detects Stripe idempotency body mismatch', () => {
	const mismatch = new StripeApiError(
		'Stripe API request failed with HTTP 400.',
		{
			status: 400,
			stripeMessage:
				'Keys for idempotent requests can only be used with the same parameters they were first used with.',
		},
	)
	expect(isStripeIdempotencyParameterMismatchError(mismatch)).toBe(true)
	expect(
		isStripeIdempotencyParameterMismatchError(
			new StripeApiError('Stripe API request failed with HTTP 400.', {
				status: 400,
				stripeMessage: 'Invalid integer: abc',
			}),
		),
	).toBe(false)
})

test('listPaymentIntentsForCustomer follows has_more pages', async () => {
	using fetchMock = fetchReturning(
		jsonResponse({
			data: [
				{
					id: 'pi_page1',
					status: 'succeeded',
					amount: 1000,
					currency: 'usd',
					metadata: {},
				},
			],
			has_more: true,
		}),
		jsonResponse({
			data: [
				{
					id: 'pi_page2',
					status: 'succeeded',
					amount: 500,
					currency: 'usd',
					metadata: { kody_credit_auto_refill: '1' },
				},
			],
			has_more: false,
		}),
	)
	const mockEnv = {
		...env,
		STRIPE_API_BASE_URL: 'https://stripe.mock',
	}
	const intents = await listPaymentIntentsForCustomer(mockEnv, 'cus_1', {
		limit: 1,
		maxPages: 3,
	})
	expect(intents.map((intent) => intent.id)).toEqual(['pi_page1', 'pi_page2'])
	expect(queryOf(fetchMock.mock.calls[1]?.[0])).toMatchObject({
		customer: 'cus_1',
		limit: '1',
		starting_after: 'pi_page1',
	})
})

test('stripe client scales a credit note down to the refund cap before issuing it', async () => {
	const issued = (refundAmount: number) =>
		jsonResponse({
			id: 'cn_capped',
			object: 'credit_note',
			invoice: 'in_upgrade',
			total: refundAmount,
			currency: 'usd',
			status: 'issued',
			metadata: { kody_account_deletion: '1' },
		})
	const upgradeLines = [
		{ invoiceLineItemId: 'il_pro', amount: 2000 },
		{ invoiceLineItemId: 'il_addon', amount: 610 },
	]
	function cappedNote(total: number) {
		return { outcome: 'issued', id: 'cn_capped', total, currency: 'usd' }
	}

	// Preview exceeds the cap: every line is scaled by cap / total (floored)
	// and previewed again before the note is created for the second total.
	{
		using fetchMock = fetchReturning(
			previewTotalling(2610),
			previewTotalling(1699),
			issued(1699),
		)
		await expect(refund(upgradeLines, 1700)).resolves.toEqual(cappedNote(1699))
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(lineAmountsOf(fetchMock.mock.calls[0]![0])).toEqual([2000, 610])
		// floor(2000 * 1700 / 2610) = 1302, floor(610 * 1700 / 2610) = 397
		expect(lineAmountsOf(fetchMock.mock.calls[1]![0])).toEqual([1302, 397])
		expect(formOf(fetchMock.mock.calls[2]![1])).toMatchObject({
			'lines[0][amount]': '1302',
			'lines[1][amount]': '397',
			refund_amount: '1699',
		})
	}

	// Discount and tax rounding can leave the scaled preview a hair above
	// the cap; the lines are scaled by the new ratio (gross amounts against
	// the net, tax-inclusive preview only ever meet as a ratio) and
	// previewed again until the total fits.
	{
		using fetchMock = fetchReturning(
			previewTotalling(2610),
			previewTotalling(1702),
			previewTotalling(1701),
			previewTotalling(1700),
			issued(1700),
		)
		await expect(refund(upgradeLines, 1700)).resolves.toEqual(cappedNote(1700))
		expect(fetchMock).toHaveBeenCalledTimes(5)
		// floor(1302 * 1700 / 1702) = 1300, floor(397 * 1700 / 1702) = 396
		expect(lineAmountsOf(fetchMock.mock.calls[2]![0])).toEqual([1300, 396])
		// floor(1300 * 1700 / 1701) = 1299, floor(396 * 1700 / 1701) = 395
		expect(lineAmountsOf(fetchMock.mock.calls[3]![0])).toEqual([1299, 395])
		expect(formOf(fetchMock.mock.calls[4]![1])).toMatchObject({
			'lines[0][amount]': '1299',
			'lines[1][amount]': '395',
			refund_amount: '1700',
		})
	}

	// A cap so small every line floors to zero means nothing to refund.
	{
		using fetchMock = fetchReturning(previewTotalling(2610))
		await expect(
			refund(
				[
					{ invoiceLineItemId: 'il_pro', amount: 1305 },
					{ invoiceLineItemId: 'il_addon', amount: 1305 },
				],
				1,
			),
		).resolves.toEqual({ outcome: 'nothing_to_refund' })
		expect(fetchMock).toHaveBeenCalledOnce()
	}

	// A preview that never drops under the cap however far the lines shrink
	// stops after the attempt budget and reports unfittable instead of
	// throwing or issuing a note above the cap; the caller decides what a
	// missing refund means.
	{
		using fetchMock = stubFetch(
			vi.fn<typeof fetch>(async () => previewTotalling(1705)),
		)
		await expect(
			refund([{ invoiceLineItemId: 'il_pro', amount: 2610 }], 1700),
		).resolves.toEqual({ outcome: 'unfittable', lastPreviewMinor: 1705 })
		expect(fetchMock).toHaveBeenCalledTimes(creditNoteCapFitAttempts + 1)
		// Every pass shrinks the line: floor(2610 * 1700 / 1705) = 2602, ...
		expect(fetchMock.mock.calls.map(([url]) => lineAmountsOf(url)[0])).toEqual([
			2610, 2602, 2594, 2586, 2578, 2570, 2562,
		])
		for (const [url, init] of fetchMock.mock.calls) {
			expect(new URL(String(url)).pathname).toBe('/v1/credit_notes/preview')
			expect(init).toMatchObject({ method: 'GET' })
		}
	}

	// A rejected create names the invoice and the amounts involved (never
	// Stripe's message, which can embed other ids) so it is diagnosable.
	consoleError.mockImplementation(() => {})
	using _fetchMock = fetchReturning(
		previewTotalling(1450),
		jsonResponse(
			{
				error: {
					type: 'invalid_request_error',
					message:
						'Credit note amount for in_upgrade exceeds the remaining creditable amount.',
				},
			},
			400,
		),
	)
	const rejected = await expectStripeError(
		refund([{ invoiceLineItemId: 'il_pro', amount: 1450 }], 1700),
		400,
	)
	expect(rejected).toMatchObject({
		message:
			'Stripe rejected the credit note for in_upgrade (previewed 1450, cap 1700, HTTP 400).',
		stripeMessage: expect.stringContaining('exceeds'),
	})
	expect(isStripeNothingToRefundError(rejected)).toBe(false)
	expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
		status: 400,
		path: '/v1/credit_notes',
	})
})

test('stripe client rejects missing config and maps API failure shapes', async () => {
	await expect(getCheckoutSession({}, 'cs_test')).rejects.toBeInstanceOf(
		BillingNotConfiguredError,
	)
	silenceExpectedConsoleErrors(['stripe_api_error'])

	const cases: Array<[Response, () => Promise<unknown>, number]> = [
		[
			jsonResponse({ id: 'cs_null_url', url: null }),
			() => createCheckoutSession(env, checkoutInput),
			502,
		],
		[
			jsonResponse({ error: { message: 'nope' } }, 402),
			() => createCheckoutSession(env, checkoutInput),
			402,
		],
		[
			jsonResponse({ error: { message: 'nope' } }, 404),
			() => getCheckoutSession(env, 'cs_missing'),
			404,
		],
		[
			jsonResponse({ id: 123, unexpected: true }),
			() => getCheckoutSession(env, 'cs_bad'),
			502,
		],
		[
			jsonResponse({ data: 'not-an-array' }),
			() => listSubscriptions(env, 'cus_1'),
			502,
		],
		[
			jsonResponse({ not_url: true }),
			() =>
				createBillingPortalSession(env, {
					customerId: 'cus_1',
					returnUrl: 'https://example.com',
				}),
			502,
		],
	]
	for (const [response, call, status] of cases) {
		using _fetchMock = fetchReturning(response)
		await expectStripeError(call(), status)
	}

	using fetchMock = stubFetch(vi.fn())
	await expectStripeError(getCheckoutSession(env, '   '), 400)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('credit top-up checkout and off-session refill send the expected Stripe contracts', async () => {
	const mockEnv = { ...env, STRIPE_API_BASE_URL: 'https://stripe.mock' }
	using fetchMock = fetchReturning(
		jsonResponse({ id: 'cs_credit', url: 'https://checkout.stripe.com/c' }),
		jsonResponse({
			id: 'cs_credit',
			mode: 'payment',
			status: 'complete',
			payment_status: 'paid',
			amount_total: 2500,
			currency: 'usd',
			customer: 'cus_1',
			client_reference_id: 'ref',
			metadata: { kody_credit_top_up: '1' },
			payment_intent: { id: 'pi_1', payment_method: 'pm_1' },
		}),
		jsonResponse({
			id: 'pi_refill',
			status: 'succeeded',
			amount: 1000,
			currency: 'usd',
		}),
	)
	expect(
		await createCreditTopUpCheckoutSession(mockEnv, {
			customerId: 'cus_1',
			amountCents: 2500,
			clientReferenceId: 'ref',
			successUrl:
				'https://app.example.com/account/usage?topup=success&session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://app.example.com/account/usage#credits',
			metadata: { kody_credit_top_up: '1', kody_stable_user_id: 'user-1' },
		}),
	).toEqual({ id: 'cs_credit', url: 'https://checkout.stripe.com/c' })
	expect(formOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
		mode: 'payment',
		customer: 'cus_1',
		'line_items[0][price_data][unit_amount]': '2500',
		'line_items[0][price_data][currency]': 'usd',
		'payment_intent_data[setup_future_usage]': 'off_session',
		'metadata[kody_credit_top_up]': '1',
	})

	const read = await getCreditTopUpCheckoutSession(mockEnv, 'cs_credit')
	expect(read.payment_intent?.payment_method).toBe('pm_1')
	expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
		'expand%5B%5D=payment_intent',
	)

	const intent = await createOffSessionPaymentIntent(mockEnv, {
		customerId: 'cus_1',
		paymentMethodId: 'pm_1',
		amountCents: 1000,
		description: 'Kody credits auto-refill',
		idempotencyKey: 'kody-credit-auto-refill:user-1:2026-09:1',
		metadata: { kody_credit_auto_refill: '1' },
	})
	expect(intent.status).toBe('succeeded')
	const refillInit = fetchMock.mock.calls[2]?.[1] as RequestInit
	expect(formOf(refillInit)).toMatchObject({
		off_session: 'true',
		confirm: 'true',
		payment_method: 'pm_1',
	})
	expect(
		(refillInit.headers as Record<string, string>)['idempotency-key'],
	).toBe('kody-credit-auto-refill:user-1:2026-09:1')
})

test('findActivePromotionCode looks up an active code by its customer-facing text', async () => {
	{
		using fetchMock = fetchReturning(
			jsonResponse({
				data: [
					{
						id: 'promo_agency_1',
						code: 'AGENCY-1',
						active: true,
						expires_at: 1_800_000_000,
						max_redemptions: 1,
						times_redeemed: 0,
						coupon: { id: 'kody-agency-first-month' },
					},
				],
			}),
		)
		expect(await findActivePromotionCode(env, ' agency-1 ')).toEqual({
			id: 'promo_agency_1',
			code: 'AGENCY-1',
			active: true,
			expires_at: 1_800_000_000,
			max_redemptions: 1,
			times_redeemed: 0,
		})
		const [url, init] = fetchMock.mock.calls[0]!
		expect(String(url)).toBe(
			'https://api.stripe.com/v1/promotion_codes?code=agency-1&active=true&limit=1',
		)
		expect(init?.method).toBe('GET')
	}
	{
		using _fetchMock = fetchReturning(jsonResponse({ data: [] }))
		expect(await findActivePromotionCode(env, 'NOPE')).toBeNull()
	}
})

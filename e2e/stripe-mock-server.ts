import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

/** Local provider simulator. Never imported by the application or deployed. */
export async function startStripeMock() {
	const token = `sk_test_e2e_${randomUUID()}`
	const sessions = new Map<
		string,
		{ form: URLSearchParams; paid: boolean; customer: string }
	>()
	const portals = new Map<string, string>()
	// Plan-transfer state. Customers named `cus_e2e_pro_<interval>_*` start
	// with one paid Pro subscription so a spec can seed a paid org in D1.
	const day = 86_400
	const canceled = new Set<string>()
	const creditNotes: Array<Record<string, unknown>> = []
	const balanceTransactions: Array<Record<string, unknown>> = []
	const idempotent = new Map<string, unknown>()
	const metadataOf = (form: URLSearchParams) =>
		Object.fromEntries(
			[...form]
				.filter(([key]) => /^metadata\[.+\]$/.test(key))
				.map(([key, value]) => [key.slice(9, -1), value]),
		)
	const linesTotal = (form: URLSearchParams) =>
		[...form]
			.filter(([key]) => /^lines\[\d+\]\[amount\]$/.test(key))
			.reduce((sum, [, value]) => sum + Number(value), 0)
	const seededPlan = (customer: string | null) => {
		const match = /^cus_e2e_pro_(month|year)_/.exec(customer ?? '')
		if (!match) return null
		const interval = match[1] as 'month' | 'year'
		const nowSeconds = Math.floor(Date.now() / 1000)
		const start = nowSeconds - (interval === 'month' ? 10 : 100) * day
		const end = start + (interval === 'month' ? 30 : 365) * day
		const id = `sub_${customer}`
		return {
			subscription: {
				id,
				customer,
				status: canceled.has(id) ? 'canceled' : 'active',
				cancel_at: null,
				current_period_end: end,
				currency: 'usd',
				items: {
					data: [
						{
							id: `si_${customer}`,
							quantity: 1,
							price: {
								id: interval === 'month' ? 'price_pro' : 'price_pro_yearly',
							},
							current_period_end: end,
						},
					],
				},
			},
			invoice: {
				id: `in_${customer}`,
				subscription: id,
				amount_paid: interval === 'month' ? 1_200 : 12_000,
				currency: 'usd',
				lines: {
					data: [
						{
							id: `il_${customer}`,
							amount: interval === 'month' ? 1_200 : 12_000,
							period: { start, end },
						},
					],
				},
			},
		}
	}
	const seededPlanForSubscription = (subscription: string | null) =>
		subscription?.startsWith('sub_cus_e2e_pro_')
			? seededPlan(subscription.slice('sub_'.length))
			: null
	let origin = ''
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', origin)
			const json = (body: unknown, status = 200) => {
				response.writeHead(status, { 'content-type': 'application/json' })
				response.end(JSON.stringify(body))
			}
			const html = (body: string) => {
				response.writeHead(200, {
					'content-type': 'text/html',
					'cache-control': 'no-store',
				})
				response.end(`<!doctype html><html><body>${body}</body></html>`)
			}
			const go = (href: string) => {
				response.writeHead(303, { location: href })
				response.end()
			}
			if (url.pathname.startsWith('/checkout/')) {
				const id = url.pathname.slice('/checkout/'.length)
				const session = sessions.get(id)
				if (!session) return json({ error: { code: 'resource_missing' } }, 404)
				if (request.method === 'POST') {
					session.paid = true
					return go(
						session.form
							.get('success_url')!
							.replace('{CHECKOUT_SESSION_ID}', id)
							.replace('%7BCHECKOUT_SESSION_ID%7D', id),
					)
				}
				return html(
					'<h1>Test checkout</h1><form method="post"><button>Complete test payment</button></form>',
				)
			}
			if (url.pathname.startsWith('/portal/')) {
				const target = portals.get(url.pathname.slice('/portal/'.length))
				if (!target) return json({}, 404)
				if (request.method === 'POST') return go(target)
				return html(
					'<h1>Test billing portal</h1><form method="post"><button>Return to Kody</button></form>',
				)
			}
			if (request.headers.authorization !== `Bearer ${token}`)
				return json({ error: { message: 'Unauthorized' } }, 401)
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			const form = new URLSearchParams(Buffer.concat(chunks).toString())
			const idempotencyKey = request.headers['idempotency-key']
			if (typeof idempotencyKey === 'string' && idempotent.has(idempotencyKey))
				return json(idempotent.get(idempotencyKey))
			const remember = (body: unknown) => {
				if (typeof idempotencyKey === 'string')
					idempotent.set(idempotencyKey, body)
				return json(body)
			}
			if (
				request.method === 'POST' &&
				url.pathname === '/v1/checkout/sessions'
			) {
				// Provider redirects may only return to the local application.
				for (const key of ['success_url', 'cancel_url']) {
					const destination = new URL(form.get(key) ?? '')
					if (
						destination.protocol !== 'http:' ||
						!['localhost', '127.0.0.1'].includes(destination.hostname)
					)
						return json({ error: { message: 'Non-local return URL' } }, 400)
				}
				const id = `cs_${randomUUID()}`
				sessions.set(id, {
					form,
					paid: false,
					customer: form.get('customer') ?? `cus_${randomUUID()}`,
				})
				return json({ id, url: `${origin}/checkout/${id}` })
			}
			if (
				request.method === 'GET' &&
				url.pathname.startsWith('/v1/checkout/sessions/')
			) {
				const id = url.pathname.slice('/v1/checkout/sessions/'.length)
				const session = sessions.get(id)
				if (!session) return json({ error: { code: 'resource_missing' } }, 404)
				const metadata = Object.fromEntries(
					[...session.form]
						.filter(([key]) => /^metadata\[.+\]$/.test(key))
						.map(([key, value]) => [key.slice(9, -1), value]),
				)
				return json({
					id,
					customer: session.customer,
					client_reference_id: session.form.get('client_reference_id'),
					metadata,
					mode: session.form.get('mode'),
					status: session.paid ? 'complete' : 'open',
					payment_status: session.paid ? 'paid' : 'unpaid',
					currency: 'usd',
					amount_total: Number(
						session.form.get('line_items[0][price_data][unit_amount]') ?? 0,
					),
					payment_intent: session.paid
						? { id: `pi_${id}`, payment_method: `pm_${id}` }
						: null,
				})
			}
			if (
				request.method === 'POST' &&
				/^\/v1\/customers\/[^/]+$/.test(url.pathname)
			) {
				const customer = url.pathname.slice('/v1/customers/'.length)
				if (
					!seededPlan(customer) &&
					![...sessions.values()].some(
						(session) => session.customer === customer,
					)
				)
					return json({ error: { code: 'resource_missing' } }, 404)
				return json({
					id: customer,
					metadata: Object.fromEntries(
						[...form]
							.filter(([key]) => /^metadata\[.+\]$/.test(key))
							.map(([key, value]) => [key.slice(9, -1), value]),
					),
				})
			}
			if (request.method === 'GET' && url.pathname === '/v1/subscriptions') {
				const seeded = seededPlan(url.searchParams.get('customer'))
				return json({
					has_more: false,
					data: [
						...(seeded ? [seeded.subscription] : []),
						...[...sessions]
							.filter(
								([, session]) =>
									session.customer === url.searchParams.get('customer') &&
									session.paid &&
									session.form.get('mode') === 'subscription',
							)
							.map(([id, session]) => ({
								id: `sub_${id}`,
								status: 'active',
								cancel_at: null,
								currency: 'usd',
								current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
								items: {
									data: [
										{
											id: `si_${id}`,
											quantity: Number(
												session.form.get('line_items[0][quantity]') ?? 1,
											),
											price: { id: session.form.get('line_items[0][price]') },
										},
									],
								},
							})),
					],
				})
			}
			const subscriptionPath = /^\/v1\/subscriptions\/([^/]+)$/.exec(
				url.pathname,
			)
			if (request.method === 'DELETE' && subscriptionPath) {
				const seeded = seededPlanForSubscription(subscriptionPath[1]!)
				if (!seeded) return json({ error: { code: 'resource_missing' } }, 404)
				canceled.add(seeded.subscription.id)
				return json({ id: seeded.subscription.id, status: 'canceled' })
			}
			if (request.method === 'GET' && url.pathname === '/v1/invoices') {
				const seeded = seededPlanForSubscription(
					url.searchParams.get('subscription'),
				)
				return json({ data: seeded ? [seeded.invoice] : [], has_more: false })
			}
			if (
				request.method === 'GET' &&
				url.pathname === '/v1/credit_notes/preview'
			) {
				return json({ total: linesTotal(url.searchParams), currency: 'usd' })
			}
			if (request.method === 'GET' && url.pathname === '/v1/credit_notes') {
				return json({
					data: creditNotes.filter(
						(note) => note.invoice === url.searchParams.get('invoice'),
					),
					has_more: false,
				})
			}
			if (request.method === 'POST' && url.pathname === '/v1/credit_notes') {
				const note = {
					id: `cn_${randomUUID()}`,
					invoice: form.get('invoice'),
					total: linesTotal(form),
					currency: 'usd',
					status: 'issued',
					metadata: metadataOf(form),
				}
				creditNotes.push(note)
				return remember(note)
			}
			const balancePath =
				/^\/v1\/customers\/([^/]+)\/balance_transactions$/.exec(url.pathname)
			if (balancePath && request.method === 'GET') {
				return json({
					data: balanceTransactions.filter(
						(txn) => txn.customer === balancePath[1],
					),
					has_more: false,
				})
			}
			if (balancePath && request.method === 'POST') {
				const txn = {
					id: `cbtxn_${randomUUID()}`,
					customer: balancePath[1],
					amount: Number(form.get('amount')),
					currency: form.get('currency') ?? 'usd',
					metadata: metadataOf(form),
				}
				balanceTransactions.push(txn)
				return remember(txn)
			}
			if (
				request.method === 'POST' &&
				url.pathname === '/v1/billing_portal/sessions'
			) {
				const target = new URL(form.get('return_url') ?? '')
				if (
					target.protocol !== 'http:' ||
					!['localhost', '127.0.0.1'].includes(target.hostname)
				)
					return json({}, 400)
				const id = randomUUID()
				portals.set(id, target.href)
				return json({ url: `${origin}/portal/${id}` })
			}
			return json(
				{
					error: {
						message: `Unsupported mock endpoint: ${request.method} ${url.pathname}`,
					},
				},
				501,
			)
		} catch (error) {
			response.writeHead(500)
			response.end(String(error))
		}
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string')
		throw new Error('Missing Stripe mock address')
	origin = `http://127.0.0.1:${address.port}`
	return {
		origin,
		token,
		async close() {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		},
	}
}

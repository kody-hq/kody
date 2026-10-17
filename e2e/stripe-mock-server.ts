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
				url.pathname.startsWith('/v1/customers/')
			) {
				const customer = url.pathname.slice('/v1/customers/'.length)
				if (
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
				return json({
					data: [...sessions]
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
				})
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

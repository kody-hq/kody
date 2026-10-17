import { expect, test, vi } from 'vitest'
import { protocolCsrf } from './cross-origin-protection.ts'

async function run(
	path: string,
	headers: HeadersInit = {},
	handlerType: 'router' | 'serverFn' = 'router',
	method = 'POST',
) {
	const request = new Request(`https://kody.test${path}`, { method, headers })
	const server = protocolCsrf.options.server!
	const response = new Response('accepted')
	const next = vi.fn(() => ({
		request,
		pathname: new URL(request.url).pathname,
		context: {},
		response,
	}))
	const result = await server({
		request,
		pathname: new URL(request.url).pathname,
		handlerType,
		context: { nonce: 'test' },
		next: next as Parameters<typeof server>[0]['next'],
	})
	return {
		response: result instanceof Response ? result : result.response,
		next,
	}
}
test.each([
	[{ Origin: 'https://kody.test' }, 200],
	[{ 'Sec-Fetch-Site': 'same-origin' }, 200],
	[{ 'Sec-Fetch-Site': 'none' }, 200],
	[{ Origin: 'https://evil.test' }, 403],
	[{ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://kody.test' }, 403],
	[{ Referer: 'https://kody.test/docs' }, 200],
	[{ Referer: 'https://kody.test.evil.test/docs' }, 403],
	[{ Referer: 'https://evil.test/docs' }, 403],
	[{}, 200],
] as const)(
	'protocol CSRF checks browser metadata while allowing originless CLI requests: %j',
	async (headers, status) => {
		const result = await run('/auth', headers)
		expect(result.response.status).toBe(status)
		expect(result.next).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
	},
)
test.each([
	'/webhooks/stripe',
	'/@acme/webhooks/package/hook/secret',
	'/sentry-tunnel',
	'/unsubscribe/tips?token=abc',
])('external protocol bypass is exact for %s', async (path) => {
	expect(
		(await run(path, { 'Sec-Fetch-Site': 'cross-site' })).response.status,
	).toBe(200)
})
test.each([
	'/webhooks/stripe/extra',
	'/webhooks/stripe-evil',
	'/@acme/webhooks/package/hook',
	'/@acme/webhooks/package/hook/secret/extra',
	'/sentry-tunnel/extra',
	'/unsubscribe/tips/extra',
])('lookalike path gets no bypass: %s', async (path) => {
	expect(
		(await run(path, { 'Sec-Fetch-Site': 'cross-site' })).response.status,
	).toBe(403)
})
test('safe reads bypass protocol CSRF and RPC delegates to the separate strict native policy', async () => {
	expect(
		(await run('/account', { 'Sec-Fetch-Site': 'cross-site' }, 'router', 'GET'))
			.response.status,
	).toBe(200)
	const rpc = await run(
		'/_serverFn/mutate',
		{ 'Sec-Fetch-Site': 'cross-site' },
		'serverFn',
	)
	expect(rpc.next).toHaveBeenCalledOnce()
})

test.each([
	[{ Origin: 'https://evil.test' }, 403],
	[{ 'Sec-Fetch-Site': 'cross-site' }, 403],
	[{ Origin: 'https://kody.test', 'Sec-Fetch-Site': 'same-origin' }, 200],
	[{}, 200],
] as const)(
	'OAuth consent POST uses native browser CSRF protection: %j',
	async (headers, status) => {
		const result = await run(
			'/oauth/authorize?client_id=app&state=client-state',
			headers,
		)
		expect(result.response.status).toBe(status)
		expect(result.next).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
	},
)

import { expect, test } from 'vitest'
import { secureNativeResponse } from './native-response-envelope.ts'
const env = { APP_BASE_URL: 'https://kody.test' } as Env
function missing(method = 'GET', accept = 'text/markdown') {
	return secureNativeResponse(
		new Request('https://kody.test/missing', {
			method,
			headers: { Accept: accept },
		}),
		new Response('<!doctype html><title>Not found</title>', {
			status: 404,
			headers: {
				'Content-Type': 'text/html',
				Vary: 'Cookie',
				'Cache-Control': 'private, no-store',
			},
		}),
		env,
		'request-nonce',
	)
}
test('native generic markdown 404 preserves status, privacy, security and negotiation', async () => {
	const response = missing()
	expect(response.status).toBe(404)
	expect(response.headers.get('Content-Type')).toContain('text/markdown')
	expect(response.headers.get('Vary')).toMatch(/Cookie.*Accept/)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('Content-Security-Policy')).toContain(
		"'nonce-request-nonce'",
	)
	expect(await response.text()).toContain('https://kody.test')
	expect(await missing('HEAD').text()).toBe('')
})
test('HTML stays default and protocol JSON errors never turn into markdown', async () => {
	const html = missing('GET', 'text/html, text/markdown;q=0.5')
	expect(html.headers.get('Content-Type')).toBe('text/html')
	expect(html.headers.get('Vary')).toMatch(/Accept/)
	expect(await html.text()).toContain('<title>Not found</title>')
	const json = secureNativeResponse(
		new Request('https://kody.test/api/missing', {
			headers: { Accept: 'text/markdown' },
		}),
		Response.json({ error: 'missing' }, { status: 404 }),
		env,
		'nonce',
	)
	expect(json.headers.get('Content-Type')).toContain('application/json')
	expect(await json.json()).toEqual({ error: 'missing' })
})

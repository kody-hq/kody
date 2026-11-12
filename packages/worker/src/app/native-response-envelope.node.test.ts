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

test('HTML advertises desktop navigation, without advertising it on JSON or markdown', () => {
	const response = secureNativeResponse(
		new Request('https://kody.test/login', { method: 'HEAD' }),
		new Response('<!doctype html>', {
			headers: { 'Content-Type': 'text/html' },
		}),
		env,
		'nonce',
	)
	expect(response.headers.get('X-Kody-Desktop-Navigation')).toBe('1')
	expect(missing().headers.has('X-Kody-Desktop-Navigation')).toBe(false)
	const json = secureNativeResponse(
		new Request('https://kody.test/api'),
		Response.json({}),
		env,
		'nonce',
	)
	expect(json.headers.has('X-Kody-Desktop-Navigation')).toBe(false)
})

test('only the preview protocol gets its isolated document policy', () => {
	for (const [path, method, marked, isolated] of [
		['/html-preview/jane', 'GET', true, true],
		['/html-preview/jane', 'POST', true, false],
		['/html-preview/jane', 'GET', false, false],
		['/account', 'GET', true, false],
	] as const) {
		const response = secureNativeResponse(
			new Request(`https://kody.test${path}`, { method }),
			new Response('preview', {
				headers: marked ? { 'X-Kody-Isolated-Preview': '1' } : {},
			}),
			env,
			'nonce',
		)
		const csp = response.headers.get('Content-Security-Policy')!
		expect(csp.includes('sandbox allow-scripts')).toBe(isolated)
		expect(csp.includes("script-src 'unsafe-inline'")).toBe(isolated)
		if (isolated) {
			expect(response.headers.get('X-Frame-Options')).toBeNull()
			expect(response.headers.get('Cache-Control')).toBe('private, no-store')
			expect(response.headers.get('Permissions-Policy')).toContain('camera=()')
		}
	}
})

test('Office previews keep their opaque sandbox and permit only the selected renderer script', () => {
	const script = '/office-viewers/docx-123456789abc.js'
	const response = secureNativeResponse(
		new Request(
			'https://kody.test/office-preview/jane/docx?script=' +
				encodeURIComponent(script),
		),
		new Response('wrapper', {
			headers: { 'Content-Type': 'text/html', 'X-Kody-Office-Preview': '1' },
		}),
		env,
		'nonce',
	)
	expect(response.headers.get('Content-Security-Policy')).toContain(
		'script-src https://kody.test' + script,
	)
	expect(response.headers.get('Content-Security-Policy')).toContain(
		'sandbox allow-scripts',
	)
	expect(response.headers.get('Content-Security-Policy')).not.toContain(
		'allow-same-origin',
	)
	expect(response.headers.get('Content-Security-Policy')).not.toContain(
		"script-src 'unsafe-inline'",
	)
	expect(response.headers.get('Cache-Control')).toBe('private, no-store')
})
test('private asset envelopes preserve streaming ranges while keeping SVG scripts disabled', () => {
	const request = new Request(
		'https://kody.test/file-assets/jane/00000000-0000-4000-8000-000000000001',
	)
	const response = secureNativeResponse(
		request,
		new Response('part', {
			status: 206,
			headers: {
				'X-Kody-File-Asset': '1',
				'Content-Type': 'image/svg+xml',
				'Content-Range': 'bytes 0-3/100',
				'Content-Disposition': 'inline',
			},
		}),
		env,
		'nonce',
	)
	expect(response.status).toBe(206)
	expect(response.headers.get('Content-Range')).toBe('bytes 0-3/100')
	expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
	expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
})

test('WebSocket upgrades retain the original connection response', () => {
	const upgrade = { status: 101 } as Response
	expect(
		secureNativeResponse(
			new Request('https://kody.test/file-session/jane/file'),
			upgrade,
			env,
			'nonce',
		),
	).toBe(upgrade)
})

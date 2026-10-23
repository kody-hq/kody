import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	defaultOpenApiSpecUrl,
	handleApiDocsRequest,
	openApiProxyPath,
	type ApiDocsWorkerEnv,
} from './docs.ts'

function createEnv(
	overrides: Partial<ApiDocsWorkerEnv> = {},
): ApiDocsWorkerEnv {
	return {
		OPENAPI_SPEC_URL: defaultOpenApiSpecUrl,
		APP_COMMIT_SHA: 'docs-commit',
		...overrides,
	}
}

test('root serves Scalar HTML pointing at the proxied OpenAPI path', async () => {
	const response = await handleApiDocsRequest(
		new Request('https://api-docs.kody.codes/'),
		createEnv(),
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('data-url="/openapi.json"')
	expect(html).toContain(
		'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.3/dist/browser/standalone.js',
	)
	expect(html).toContain(
		'integrity="sha384-HWi/QCSPi64AQ0xBXFGDk+7gmvZ4hJ/7sZMIXqWVz6Ikb6+Cxej/hWKaomOStyFb"',
	)
	expect(html).toContain('crossorigin="anonymous"')
	expect(response.headers.get('Content-Security-Policy')).toBe(
		"default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https:; font-src https: data:; img-src 'self' https: data:; connect-src 'self' https://api.kody.codes; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
	)
	expect(html).not.toMatch(/kody_at_/)
})

test('docs CSP connects to the configured spec origin and is only set on HTML', async () => {
	const root = await handleApiDocsRequest(
		new Request('https://api-docs.kody.codes/'),
		createEnv({ OPENAPI_SPEC_URL: 'https://api.example.test/v2/openapi.json' }),
	)
	expect(root.headers.get('Content-Security-Policy')).toContain(
		"connect-src 'self' https://api.example.test;",
	)

	const health = await handleApiDocsRequest(
		new Request('https://api-docs.kody.codes/health'),
		createEnv(),
	)
	expect(health.headers.get('Content-Security-Policy')).toBeNull()
})

test('openapi proxy forwards the upstream document', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		Response.json(
			{ openapi: '3.1.0', info: { title: 'Kody API' } },
			{
				headers: {
					'Cache-Control': 'public, max-age=300',
					ETag: '"abc"',
				},
			},
		),
	)

	const response = await handleApiDocsRequest(
		new Request(`https://api-docs.kody.codes${openApiProxyPath}`),
		createEnv({ OPENAPI_SPEC_URL: 'https://api.example.test/openapi.json' }),
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		openapi: '3.1.0',
		info: { title: 'Kody API' },
	})
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
	expect(response.headers.get('ETag')).toBe('"abc"')
	expect(response.headers.get('Content-Security-Policy')).toBeNull()
	expect(fetchMock).toHaveBeenCalledWith(
		'https://api.example.test/openapi.json',
		expect.objectContaining({ method: 'GET' }),
	)
	fetchMock.mockRestore()
})

test('openapi proxy revalidates with If-None-Match and returns upstream 304', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(null, {
			status: 304,
			headers: {
				ETag: '"abc"',
				'Cache-Control': 'public, max-age=300',
			},
		}),
	)

	const response = await handleApiDocsRequest(
		new Request(`https://api-docs.kody.codes${openApiProxyPath}`, {
			headers: { 'If-None-Match': '"abc"' },
		}),
		createEnv({ OPENAPI_SPEC_URL: 'https://api.example.test/openapi.json' }),
	)
	expect(response.status).toBe(304)
	expect(await response.text()).toBe('')
	expect(response.headers.get('ETag')).toBe('"abc"')
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
	expect(fetchMock).toHaveBeenCalledWith(
		'https://api.example.test/openapi.json',
		expect.objectContaining({
			method: 'GET',
			headers: expect.any(Headers),
		}),
	)
	const upstreamHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers
	expect(upstreamHeaders.get('If-None-Match')).toBe('"abc"')
	fetchMock.mockRestore()
})

test('openapi proxy returns 502 when upstream fails', async () => {
	consoleError.mockImplementation(() => {})
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response('nope', { status: 503 }))

	const response = await handleApiDocsRequest(
		new Request(`https://api-docs.kody.codes${openApiProxyPath}`),
		createEnv(),
	)
	expect(response.status).toBe(502)
	expect(await response.json()).toMatchObject({
		error: { code: 'upstream_error' },
	})
	expect(consoleError).toHaveBeenCalled()
	fetchMock.mockRestore()
})

test('rejects non-GET methods and unknown paths', async () => {
	const post = await handleApiDocsRequest(
		new Request('https://api-docs.kody.codes/', { method: 'POST' }),
		createEnv(),
	)
	expect(post.status).toBe(405)
	expect(post.headers.get('Allow')).toBe('GET, HEAD')

	const missing = await handleApiDocsRequest(
		new Request('https://api-docs.kody.codes/nope'),
		createEnv(),
	)
	expect(missing.status).toBe(404)
})

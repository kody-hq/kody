import { expect, test } from 'vitest'
import { firstPartySecurityHeaders } from '#worker/app/security-headers.ts'

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

import { getSharedMcpE2eServer } from '../../../../tools/mcp-test-support.ts'

async function workerFetch(request: Request): Promise<Response> {
	const server = await getSharedMcpE2eServer()
	const url = new URL(request.url)
	const destination = new URL(url.pathname + url.search, server.origin)
	return fetch(new Request(destination, request), { redirect: 'manual' })
}

test('first-party HTML shell carries security headers', async () => {
	const response = await workerFetch(createRequest('/login'))
	expect(response.status).toBe(200)
	const nonce = response.headers
		.get('Content-Security-Policy')
		?.match(/'nonce-([^']+)'/)?.[1]
	expect(nonce).toBeTruthy()
	expect(await response.text()).toContain(`nonce="${nonce}"`)
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		expect(response.headers.get(name)?.replace(/ 'nonce-[^']+'/g, '')).toBe(
			value,
		)
	}
})

test('anonymous denied package settings preserve the native 404 document', async () => {
	const response = await workerFetch(
		createRequest('/@missing-owner/missing-package/settings'),
	)
	expect(response.status).toBe(404)
	const html = await response.text()
	expect(html).toContain('data-testid="not-found-page"')
	expect(html).not.toContain('data-testid="internal-error-page"')
})

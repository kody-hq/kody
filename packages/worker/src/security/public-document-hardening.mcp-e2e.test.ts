import { expect, test } from 'vitest'
import { getSharedMcpE2eServer } from '../../../../tools/mcp-test-support.ts'

async function workerFetch(request: Request): Promise<Response> {
	const server = await getSharedMcpE2eServer()
	const url = new URL(request.url)
	const destination = new URL(url.pathname + url.search, server.origin)
	return fetch(new Request(destination, request), { redirect: 'manual' })
}

test('compiled authentication endpoint rate limits abusive requests', async () => {
	let rateLimited = false
	for (let i = 0; i < 25; i++) {
		const response = await workerFetch(
			new Request('https://test.kody.dev/auth', {
				method: 'POST',
				body: JSON.stringify({
					email: 'attacker@example.com',
					password: 'password123',
					mode: 'login',
				}),
				headers: {
					'Content-Type': 'application/json',
					'CF-Connecting-IP': '198.51.100.42',
				},
			}),
		)
		if (response.status === 429) {
			rateLimited = true
			expect(response.headers.get('Retry-After')).toBeTruthy()
			break
		}
	}
	expect(rateLimited).toBe(true)
}, 60_000)

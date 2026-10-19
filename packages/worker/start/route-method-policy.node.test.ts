import { expect, test } from 'vitest'
import { routeMethodRejection } from './route-method-policy.ts'
test('document methods cannot fall through to page or token loaders', () => {
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
		const response = routeMethodRejection(method, { options: {} }, true)
		expect(response?.status).toBe(405)
		expect(response?.headers.get('Allow')).toBe('GET, HEAD')
		expect(response?.headers.get('content-type')).toBeNull()
	}
})
test('JSON POSTs to document fuzzy matches get a JSON 405 body', async () => {
	const response = routeMethodRejection(
		'POST',
		{ options: { component: () => null } },
		false,
		new Request('https://kody.test/account/secrets.json', {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
		}),
	)
	expect(response?.status).toBe(405)
	expect(response?.headers.get('content-type')).toMatch(/application\/json/)
	await expect(response?.json()).resolves.toEqual({
		ok: false,
		error: 'Method not allowed.',
	})
})
test('only an exact native protocol handler authorizes a mutation method', () => {
	const route = {
		options: { server: { handlers: { GET: () => {}, POST: () => {} } } },
	}
	expect(routeMethodRejection('POST', route, true)).toBeUndefined()
	expect(routeMethodRejection('POST', route, false)?.status).toBe(405)
	expect(
		routeMethodRejection('DELETE', route, true)?.headers.get('Allow'),
	).toBe('GET, POST, HEAD')
})
test('native handler factories and ANY handlers retain their declared methods', () => {
	const route = {
		options: {
			server: {
				handlers: ({
					createHandlers,
				}: {
					createHandlers: (
						value: Record<string, unknown>,
					) => Record<string, unknown>
				}) => createHandlers({ ANY: () => {} }),
			},
		},
	}
	expect(routeMethodRejection('PUT', route, true)).toBeUndefined()
	expect(routeMethodRejection('GET', undefined, false)).toBeUndefined()
	expect(routeMethodRejection('HEAD', undefined, false)).toBeUndefined()
})

import { expect, test } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import {
	routeMethodRejection,
	unknownPathRejection,
} from './route-method-policy.ts'
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

const routeTreeRouter = createRouter({
	origin: 'https://kody.test',
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})

function rejectUnknownPath(pathname: string, accept: string, method = 'GET') {
	const [, params, route] = routeTreeRouter.getMatchedRoutes(pathname)
	return unknownPathRejection(
		method,
		route,
		params['**'] !== undefined,
		new Request(`https://kody.test${pathname}`, { headers: { accept } }),
	)
}

test.each([
	'/.well-known/ai-catalog.json',
	'/.well-known/poppy.json',
	'/no-such-page',
	'/pricing/no-such-child',
])(
	'unknown path %s is a JSON 404 for JSON callers, not 406',
	async (pathname) => {
		const response = rejectUnknownPath(pathname, 'application/json')
		expect(response?.status).toBe(404)
		expect(response?.headers.get('content-type')).toMatch(/application\/json/)
		expect(response?.headers.get('vary')).toBe('Accept')
		expect(response?.headers.get('cache-control')).toBe('no-store')
		await expect(response?.json()).resolves.toEqual({
			ok: false,
			error: 'Not found.',
		})
	},
)

test('unknown paths are 404 for any Accept that excludes HTML', async () => {
	const response = rejectUnknownPath('/no-such-page', 'text/markdown')
	expect(response?.status).toBe(404)
	expect(response?.headers.get('content-type')).toMatch(/text\/plain/)
	expect(await response?.text()).toBe('Not found.')
	const head = rejectUnknownPath('/no-such-page', 'application/json', 'HEAD')
	expect(head?.status).toBe(404)
	expect(head?.body).toBeNull()
})

test.each(['text/html', '*/*', 'application/json, text/html;q=0.9', ''])(
	'unknown paths still render the not-found page for Accept "%s"',
	(accept) => {
		expect(rejectUnknownPath('/no-such-page', accept)).toBeUndefined()
	},
)

test('known routes keep their own content negotiation', () => {
	for (const pathname of ['/', '/pricing', '/docs/connect', '/blog/hello']) {
		expect(rejectUnknownPath(pathname, 'application/json')).toBeUndefined()
	}
	expect(
		rejectUnknownPath('/no-such-page', 'application/json', 'POST'),
	).toBeUndefined()
})

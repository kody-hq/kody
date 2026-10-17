import { expect, test } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import {
	negotiatedDocument,
	withNegotiatedDocumentVary,
} from './document-negotiation.ts'
const router = createRouter({
	origin: 'https://kody.test',
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
test.each([
	'/',
	'/use-cases',
	'/use-cases/mcp-gateway',
	'/compare/n8n-alternatives',
	'/integrations/slack',
	'/docs',
	'/docs/',
	'/docs/connect',
	'/docs/secrets',
	'/docs/secrets/',
	'/blog/hello',
])('native negotiated route %s owns the Accept cache boundary', (pathname) => {
	const [, params, route] = router.getMatchedRoutes(pathname)
	expect(params['**']).toBeUndefined()
	expect(route?.options.server?.middleware).toContain(negotiatedDocument)
})

test.each([
	'/pricing',
	'/blog',
	'/docs.json',
	'/docs/secrets.md',
	'/_serverFn/example',
])('non-negotiated path %s does not install Accept middleware', (pathname) => {
	const [matched] = router.getMatchedRoutes(pathname)
	expect(
		matched.flatMap((route) => route.options.server?.middleware ?? []),
	).not.toContain(negotiatedDocument)
})

test('unknown docs extensions remain document slugs, not protocol routes', () => {
	const [, params, route] = router.getMatchedRoutes('/docs/secrets.json')
	expect(route?.id).toBe('/docs/$slug')
	expect(params).toMatchObject({ slug: 'secrets.json' })
	expect(params['**']).toBeUndefined()
	expect(route?.options.server?.middleware).toContain(negotiatedDocument)
})

test.each([
	['/docs/connect/github', '/docs/connect'],
	['/blog/hello/image', '/blog/$slug'],
])(
	'unmatched child %s keeps its matched document middleware',
	(pathname, routeId) => {
		// Start runs matched-route middleware for fuzzy matches too. Only the
		// HTTP handler is restricted to an exact match, so error variants vary.
		const [matched, params, route] = router.getMatchedRoutes(pathname)
		expect(route?.id).toBe(routeId)
		expect(params['**']).toBeDefined()
		expect(
			matched.flatMap((entry) => entry.options.server?.middleware ?? []),
		).toContain(negotiatedDocument)
	},
)
test('HTML variants preserve status cookies body and existing cache dimensions', async () => {
	const original = new Response('page', {
		status: 404,
		headers: {
			'Content-Type': 'text/html',
			Vary: 'Cookie',
			'Set-Cookie': 'session=next',
			'Cache-Control': 'private, no-store',
		},
	})
	const response = withNegotiatedDocumentVary(original)
	expect(response.status).toBe(404)
	expect(response.headers.get('Vary')).toBe('Cookie, Accept')
	expect(response.headers.get('Set-Cookie')).toBe('session=next')
	expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	expect(await response.text()).toBe('page')
	expect(original.headers.get('Vary')).toBe('Cookie')
})
test('existing negotiated headers and protocol responses stay intact', () => {
	for (const vary of ['Accept', 'Cookie, ACCEPT', '*']) {
		const response = new Response(null, {
			headers: { 'Content-Type': 'text/html', Vary: vary },
		})
		expect(withNegotiatedDocumentVary(response)).toBe(response)
	}
	for (const contentType of ['text/markdown', 'application/json']) {
		const response = new Response(null, {
			headers: { 'Content-Type': contentType, Vary: 'Accept' },
		})
		expect(withNegotiatedDocumentVary(response)).toBe(response)
	}
})

test('negotiated redirects and bodyless responses vary without losing their contract', () => {
	for (const status of [200, 308, 404]) {
		const response = withNegotiatedDocumentVary(
			new Response(null, {
				status,
				headers: { Location: '/docs/canonical.md', Vary: 'Cookie' },
			}),
		)
		expect(response.status).toBe(status)
		expect(response.body).toBeNull()
		expect(response.headers.get('Location')).toBe('/docs/canonical.md')
		expect(response.headers.get('Vary')).toBe('Cookie, Accept')
	}
})

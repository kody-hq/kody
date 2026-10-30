import { expect, test } from 'vitest'
import {
	createRouter,
	createMemoryHistory,
	interpolatePath,
} from '@tanstack/react-router'
import { getRouteSegments } from '@tanstack/router-core'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { linkNavigation } from './link-navigation.ts'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	origin: 'https://kody.test',
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
test.each([
	['/oauth/authorize', true],
	['/oauth/callback', true],
	['/auth', true],
	['/auth/github/callback', true],
	['/llms.txt', true],
	['/docs.md', true],
	['/docs/llms.txt', true],
	['/docs/connect.md', true],
	['/docs/local-execute.md', true],
	['/docs/local-execute', false],
	['/blog/rss.xml', true],
	['/blog/some-post.md', true],
	['/blog/some-post', false],
	['/health', true],
	['/account/export.json', true],
	['/account/memories-export.json', true],
	['/account/connections', false],
	['/account/secrets', false],
	['/account/credentials', true],
	['/account/credits', true],
	['/connect/credential', true],
	['/features/integrations', true],
	['/features/secrets', true],
	['/pricing', false],
	['/unsubscribe/tips', false],
	['/not-a-route/nested', true],
])('native route owns document navigation for %s', (pathname, document) => {
	expect(linkNavigation(router, pathname).reloadDocument).toBe(document)
})

test('redirect-only native routes leave the document', () => {
	const paths = Object.values(router.routesById)
		.filter(
			(route) =>
				route.id !== '__root__' &&
				Boolean(route.options.beforeLoad) &&
				!route.options.component &&
				!route.options.loader,
		)
		.map((route) => {
			const source = route.fullPath
			const segments = getRouteSegments(route)
			if (!segments && source.includes('$'))
				throw new Error(`Missing compiled parameters for ${route.id}`)
			const params = Object.fromEntries(
				[...source.matchAll(/\$([A-Za-z]\w*)/g)].map(([, key]) => [
					key,
					key === 'orgSlug' ? 'ghost' : 'x',
				]),
			)
			return segments
				? interpolatePath(source, segments, { ...params, _splat: 'x' })
				: source
		})
	expect(paths.length).toBeGreaterThan(0)
	expect(paths).toEqual(
		expect.arrayContaining([
			'/account/credentials',
			'/account/credits',
			'/connect/credential',
		]),
	)
	for (const pathname of paths) {
		expect({
			pathname,
			reloadDocument: linkNavigation(router, pathname).reloadDocument,
		}).toEqual({ pathname, reloadDocument: true })
	}
})

// Start's client build drops routes whose only option is `server`
// (pruneServerOnlySubtrees), so links to them match an app route such as
// `/docs/$slug` in the browser and render a client-side 404.
test('server-only routes stay in the client route tree as document links', () => {
	const serverOnly = Object.values(router.routesById).filter(
		(route) =>
			route.id !== '__root__' &&
			route.options.server &&
			!route.options.component &&
			!route.options.loader &&
			!route.options.beforeLoad,
	)
	expect(serverOnly.length).toBeGreaterThan(0)
	expect(
		serverOnly
			.filter((route) => !route.options.staticData?.documentNavigation)
			.map((route) => route.id),
	).toEqual([])
})

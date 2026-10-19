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

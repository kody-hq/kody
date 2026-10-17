import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import {
	createRootRoute,
	createRoute,
	createRouter,
	createMemoryHistory,
	RouterContextProvider,
	Match,
	Outlet,
} from '@tanstack/react-router'
import { PageHead } from './page-head.tsx'

test('unmatched SSR and native navigation use Not found metadata, then restore successful route head', async () => {
	const root = createRootRoute({
		head: () => ({ meta: [{ title: 'Kody' }] }),
		shellComponent: ({ children }) =>
			createElement(
				'html',
				null,
				createElement('head', null, createElement(PageHead)),
				createElement('body', null, children),
			),
		component: Outlet,
		notFoundComponent: () => createElement('p', null, 'Missing page'),
	})
	const found = createRoute({
		getParentRoute: () => root,
		path: '/found',
		head: () => ({ meta: [{ title: 'Found page' }] }),
		component: () => createElement('p', null, 'Found'),
	})
	const router = createRouter({
		origin: 'https://kody.test',
		isServer: false,
		routeTree: root.addChildren([found]),
		history: createMemoryHistory({ initialEntries: ['/missing'] }),
	})
	await router.load()
	// Render native matches without the client transition adapter, whose layout
	// effects cannot acknowledge a commit during a server-rendered snapshot.
	const render = () =>
		renderToString(
			createElement(RouterContextProvider, {
				router,
				children: createElement(Match, { routeId: root.id }),
			}),
		)
	expect(render()).toContain('<title>Not found</title>')
	expect(router.state.matches.some((match) => match._notFound)).toBe(true)
	await router.navigate({ href: '/found' })
	expect(router.state.location.pathname).toBe('/found')
	expect(render()).toContain('<title>Found page</title>')
	await router.navigate({ href: '/missing-again' })
	expect(router.state.location.pathname).toBe('/missing-again')
	expect(render()).toContain('<title>Not found</title>')
	expect(render()).not.toContain('<title>Found page</title>')
})

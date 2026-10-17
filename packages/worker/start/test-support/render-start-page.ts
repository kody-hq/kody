import { routeTree } from '../routeTree.gen.ts'
import { pageNavigationForMatches } from '../page-navigation.ts'
import { type AppShell } from '../app-shell.ts'
import { type SessionInfo } from '#client/session.ts'
import createCache from '@emotion/cache'
import { CacheProvider } from '@emotion/react'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'

/** Render a native page with real Router and Query contexts, without mocking hooks. */
export async function renderStartPage(
	page: ReactNode,
	href: string = '/test',
	session: SessionInfo | null = null,
	seedQueries?: (client: QueryClient) => void,
	shell?: Partial<AppShell>,
) {
	const cache = createCache({ key: 'native-test' })
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	queryClient.setQueryData(['shell', null, ''], { session })
	seedQueries?.(queryClient)
	const root = createRootRouteWithContext<{
		queryClient: QueryClient
		actorKey: string | null
	}>()({
		beforeLoad: ({ location }) => {
			const lookup = createRouter({
				origin: 'https://kody.test',
				routeTree,
				history: createMemoryHistory(),
				context: { queryClient, getCommittedPage: () => null },
			})
			const [routes, params] = lookup.getMatchedRoutes(location.pathname)
			return {
				pageLocation: location,
				pageNavigation: pageNavigationForMatches(
					routes.map((route) => ({
						staticData: route.options.staticData ?? {},
						params,
					})),
				),
			}
		},
		loader: ({ location }) => ({
			shellLocation: {
				pathname: location.pathname,
				searchStr: location.searchStr,
			},
		}),
	})
	const route = createRoute({
		getParentRoute: () => root,
		path: '$',
		staticData: { shell },
		component: () => page,
	})
	const router = createRouter({
		origin: 'https://kody.test',
		routeTree: root.addChildren([route]),
		history: createMemoryHistory({ initialEntries: [href] }),
		context: { queryClient, actorKey: null },
	})
	await router.load()
	try {
		const html = renderToString(
			createElement(
				CacheProvider,
				{ value: cache },
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(RouterProvider, { router }),
				),
			),
		)
		if (html.includes('Switched to client rendering'))
			throw new Error(
				`Native SSR failed for ${href}: ${html.match(/data-msg="([^"]*)"/)?.[1] ?? 'client rendering fallback'}`,
			)
		return html
	} finally {
		queryClient.clear()
	}
}

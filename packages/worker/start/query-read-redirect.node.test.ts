import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	redirect,
} from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { expect, test, vi } from 'vitest'

for (const reloadDocument of [false, true]) {
	test(`Query read redirects have one navigation owner, document=${reloadDocument}`, async () => {
		const queryClient = new QueryClient()
		const root = createRootRoute()
		const router = createRouter({
			origin: 'https://kody.test',
			isServer: false,
			history: createMemoryHistory({ initialEntries: ['/'] }),
			routeTree: root.addChildren(
				['/', '/login'].map((path) =>
					createRoute({ getParentRoute: () => root, path }),
				),
			),
		})
		setupRouterSsrQueryIntegration({ router, queryClient })
		await router.load()
		const navigate = vi.spyOn(router, 'navigate')
		// Only a full document navigation needs a mocked browser boundary.
		if (reloadDocument) navigate.mockResolvedValue(undefined)
		const failure = redirect({ href: '/login', replace: true, reloadDocument })
		const options = {
			queryKey: [
				'follows',
				'actor',
				'target',
				{ username: 'owner', kodyId: 'pkg' },
			],
			retry: false as const,
			queryFn: async () => {
				throw failure
			},
		}
		// Multiple mounted consumers share a read and must not each navigate.
		const observers = [
			new QueryObserver(queryClient, options),
			new QueryObserver(queryClient, options),
		]
		const unsubscribe = observers.map((observer) =>
			observer.subscribe(() => {}),
		)
		try {
			await expect(queryClient.fetchQuery(options)).rejects.toBe(failure)
			expect(navigate).toHaveBeenCalledTimes(1)
			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({
					href: '/login',
					replace: true,
					reloadDocument,
				}),
			)
			expect(queryClient.getQueryState(options.queryKey)?.status).toBe('error')
			if (!reloadDocument) {
				await navigate.mock.results[0]!.value
				expect(router.state.location.pathname).toBe('/login')
			}
		} finally {
			unsubscribe.forEach((stop) => stop())
			navigate.mockRestore()
			queryClient.clear()
		}
	})
}

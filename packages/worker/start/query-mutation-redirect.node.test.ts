import { QueryClient } from '@tanstack/react-query'
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
	test(`Query redirects navigate without mutation success, document=${reloadDocument}`, async () => {
		const queryClient = new QueryClient()
		const root = createRootRoute()
		const router = createRouter({
			origin: 'https://kody.test',
			isServer: false,
			history: createMemoryHistory({ initialEntries: ['/'] }),
			routeTree: root.addChildren(
				['/', '/next'].map((path) =>
					createRoute({ getParentRoute: () => root, path }),
				),
			),
		})
		setupRouterSsrQueryIntegration({ router, queryClient })
		await router.load()
		// A document reload is the browser boundary, absent in this Node test.
		const navigate = reloadDocument
			? vi.spyOn(router, 'navigate').mockResolvedValue(undefined)
			: null
		const failure = redirect({ href: '/next', replace: true, reloadDocument })
		const onSuccess = vi.fn()
		const onSettled = vi.fn()
		const mutation = queryClient.getMutationCache().build(queryClient, {
			retry: false,
			mutationFn: async () => {
				throw failure
			},
			onSuccess,
			onSettled,
		})
		try {
			await expect(mutation.execute(undefined)).rejects.toBe(failure)
			expect(onSuccess).not.toHaveBeenCalled()
			expect(onSettled.mock.calls[0]?.[1]).toBe(failure)
			expect(mutation.state.status).toBe('error')
			if (navigate)
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						href: '/next',
						reloadDocument: true,
						replace: true,
					}),
				)
			else expect(router.state.location.pathname).toBe('/next')
		} finally {
			navigate?.mockRestore()
			queryClient.clear()
		}
	})
}

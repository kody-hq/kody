import { expect, test } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { routeMethodRejection } from './route-method-policy.ts'
import { accountPackagesHttp } from '#start/server/protocol-handlers'

const router = createRouter({
	origin: 'https://kody.test',
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})

test('POST /account/packages.json is an exact protocol route with GET HEAD POST', () => {
	const [, params, route] = router.getMatchedRoutes('/account/packages.json')
	expect(route?.id).toBe('/account_/packages.json')
	expect(params['**']).toBeUndefined()
	expect(route?.options.server?.handlers).toMatchObject({
		GET: accountPackagesHttp,
		HEAD: accountPackagesHttp,
		POST: accountPackagesHttp,
	})
	expect(routeMethodRejection('POST', route as never, true)).toBeUndefined()
	expect(routeMethodRejection('PUT', route as never, true)?.status).toBe(405)
	expect(
		routeMethodRejection('PUT', route as never, true)?.headers.get('Allow'),
	).toBe('GET, HEAD, POST')
})

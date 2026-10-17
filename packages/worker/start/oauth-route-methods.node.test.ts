import { expect, test } from 'vitest'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import {
	oauthAuthorizeDocument,
	oauthAuthorizePost,
	oauthCallbackDocument,
	rejectOAuthAuthorizeMethod,
} from '#start/server/oauth-protocol'

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
test('OAuth document dispatch belongs to Start and never enables authorize preloading or HEAD consumption', () => {
	const [, , route] = router.getMatchedRoutes('/oauth/authorize')
	expect(route?.options.preload).toBe(false)
	expect(route?.options.server?.handlers).toMatchObject({
		GET: oauthAuthorizeDocument,
		POST: oauthAuthorizePost,
		HEAD: rejectOAuthAuthorizeMethod,
		PUT: rejectOAuthAuthorizeMethod,
		PATCH: rejectOAuthAuthorizeMethod,
		DELETE: rejectOAuthAuthorizeMethod,
		OPTIONS: rejectOAuthAuthorizeMethod,
	})
})
test('callback status belongs to the native document handler', () => {
	const [, , route] = router.getMatchedRoutes('/oauth/callback')
	expect(route?.options.server?.handlers).toMatchObject({
		GET: oauthCallbackDocument,
		HEAD: oauthCallbackDocument,
	})
})

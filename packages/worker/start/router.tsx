/** @jsxImportSource @emotion/react */
import type {} from './request-context.ts'
import { type CommittedPage } from './presentation-navigation.ts'
import { readRouterNonce } from '#start/server/router-nonce'
import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { InternalErrorPage } from './components/internal-error-page.tsx'
import { captureClientException } from '#client/sentry-client.ts'
import {
	installNavigationMotion,
	persistentShellNavSelector,
} from './navigation-motion.ts'
import { readDocumentActor } from './document-actor.ts'
import { shouldDehydrateAppQuery } from './query-dehydration.ts'
import { routeTree } from './routeTree.gen'

export function getRouter() {
	const nonce = readRouterNonce()
	// Start calls this factory once per server request, and once per browser router.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				retry: false,
				// Root activation verifies identity before refreshing private queries.
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
			},
			mutations: { retry: false },
		},
	})
	if (typeof document !== 'undefined') readDocumentActor()
	const router = createRouter({
		ssr: { nonce },
		routeTree,
		context: {
			queryClient,
			getCommittedPage: (): CommittedPage | null =>
				router.state.resolvedLocation
					? {
							location: router.state.resolvedLocation,
							matches: router.state.matches,
						}
					: null,
		},
		caseSensitive: true,
		defaultErrorComponent: InternalErrorPage,
		defaultOnCatch: captureClientException,
		scrollRestoration: true,
		scrollRestorationBehavior: 'instant',
		defaultPreload: 'intent',
		defaultStaleTime: 0,
		// Router retains head metadata, but Query owns payload readiness. Wait
		// for loader completion when Query has evicted a payload. Retained stale
		// Query data still returns immediately and revalidates in the background.
		defaultStaleReloadMode: 'blocking',
		// Query owns freshness, including intent preloads.
		defaultPreloadStaleTime: 0,
	})
	setupRouterSsrQueryIntegration({
		router,
		queryClient,
		dehydrateOptions: { shouldDehydrateQuery: shouldDehydrateAppQuery },
	})
	if (typeof document !== 'undefined') {
		installNavigationMotion(router, {
			canStart: () => typeof document.startViewTransition === 'function',
			prefersReducedMotion: () =>
				matchMedia('(prefers-reduced-motion: reduce)').matches,
			hasPersistentShell: () =>
				Boolean(document.querySelector(persistentShellNavSelector)),
			markSpaNavigation: () =>
				document.documentElement.setAttribute('data-spa-nav', ''),
		})
	}
	return router
}

declare module '@tanstack/router-core' {
	interface Register {
		ssr: true
		router: ReturnType<typeof getRouter>
	}
}

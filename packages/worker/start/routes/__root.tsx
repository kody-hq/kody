/** @jsxImportSource @emotion/react */
import { homeSoftwareApplicationJsonLdScriptText } from '#universal/home-json-ld.ts'
import { publicAsset } from '../public-assets.ts'
import { pageNavigationForMatches } from '../page-navigation.ts'
import { appShellForMatches } from '../app-shell.ts'
import { requiresSessionVerification } from '../session-verification-policy.ts'
import { documentCache } from '../document-cache.ts'
import { routeMethods } from '../route-method-middleware.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildUnauthorizedErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { createScarfPageTracker } from '#client/scarf-analytics.ts'
import { FathomTracker } from '../components/fathom-tracker.tsx'
import {
	isPresentationNavigation,
	type CommittedPage,
} from '../presentation-navigation.ts'
import { orgNavigationScope } from '../org-navigation-scope.ts'
import {
	createRootRouteWithContext,
	notFound,
	isNotFound,
	isRedirect,
	Outlet,
	Scripts,
	useLocation,
	useLoaderData,
	useRouteContext,
	useRouter,
	useRouterState,
} from '@tanstack/react-router'
import { useEffect, useRef, type ReactNode } from 'react'
import { useSuspenseQuery, type QueryClient } from '@tanstack/react-query'
import { readDocumentActor } from '../document-actor.ts'
import {
	parseDocumentActor,
	documentActorMetaName,
} from '../session-identity.ts'
import { refreshOnActivation } from '../refresh-on-activation.ts'
import { refreshActiveQueries } from '../refresh-active-queries.ts'
import { captureClientException } from '#client/sentry-client.ts'
import { CANONICAL_ORIGIN_META_NAME } from '#universal/document-head-markers.ts'
import { SENTRY_CONFIG_META_NAME } from '#universal/sentry-config.ts'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { InternalErrorPage } from '../components/internal-error-page.tsx'
import { Toaster } from '../components/toaster.tsx'
import { YouTubeWatchOverlay } from '../components/youtube-watch-overlay.tsx'

import { readDocumentFailure } from '#start/server/document-failure'
import { documentForbiddenMessage } from '../document-failure.ts'
import { SiteLink } from '../components/site-link.tsx'
import { verifySession } from '#start/server/shell'
import { shellQuery, ensureShellQuery } from '../shell-query.ts'
import { NOT_FOUND_DOCUMENT_TITLE } from '#universal/document-head.ts'
import { SiteHeader } from '../components/site-header.tsx'
import { SiteFooter } from '../components/site-footer.tsx'
import { visuallyHiddenUntilFocusedCss } from '#universal/styles/style-primitives.ts'
import { PageHead } from '../components/page-head.tsx'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	appFrameCss,
	appMainCss,
	mainGutterPaddingCss,
} from '../components/app-layout.ts'
import { AppBrowserEffects } from '../components/app-browser-effects.tsx'
import '../../public/styles.css'

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient
	getCommittedPage: () => CommittedPage | null
}>()({
	server: { middleware: [routeMethods, documentCache] },
	// Query owns shell presentation freshness. Private foreground navigation
	// independently verifies the immutable document actor before committing.
	preload: false,
	shouldReload: true,
	notFoundComponent: NotFoundPage,
	shellComponent: DocumentShell,
	// Only these search values affect shell content or root head metadata.
	// Session verification is independent of presentation cache freshness.
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		youtubeId: search.youtubeId,
		og: search.og,
	}),
	beforeLoad: async ({
		location,
		abortController,
		preload,
		context,
		matches,
	}) => {
		const pageNavigation = pageNavigationForMatches(matches)
		const orgScope = orgNavigationScope(matches)
		const appShell = appShellForMatches(matches)
		if (typeof document === 'undefined') {
			const identity = await verifySession({
				data: orgScope,
				signal: abortController.signal,
			})
			const failure = readDocumentFailure()
			if (failure?.status === 404)
				throw notFound({ routeId: '__root__', data: identity })
			if (failure?.status === 403)
				throw new Error(documentForbiddenMessage, { cause: identity })
			if (failure?.status === 500)
				throw new Error('The request could not be completed.', {
					cause: identity,
				})
			return {
				...identity,
				orgScope,
				pageNavigation,
				pageLocation: location,
				appShell,
				verifyAccess: false,
				presentationOnly: false,
			}
		}
		const actorKey = parseDocumentActor(readDocumentActor())
		const presentationOnly = isPresentationNavigation({
			committed: context.getCommittedPage(),
			location,
			matches,
			actorKey,
		})
		return {
			actorKey,
			orgScope,
			pageNavigation,
			pageLocation: location,
			appShell,
			presentationOnly,
			verifyAccess:
				!preload && requiresSessionVerification(matches) && !presentationOnly,
		}
	},
	loader: {
		staleReloadMode: 'blocking',
		handler: async ({ context, location, abortController }) => {
			// Root and leaf loaders run concurrently. Every leaf RPC authorizes its
			// own read; this gate additionally protects navigation to cached data.
			// Router cannot commit the destination until both loaders succeed.
			const [shell] = await Promise.all([
				ensureShellQuery(
					context.queryClient,
					context.actorKey,
					location.searchStr,
					!context.presentationOnly,
				),
				context.verifyAccess
					? verifySession({
							data: context.orgScope,
							signal: abortController.signal,
						})
					: undefined,
			])
			abortController.signal.throwIfAborted()
			return {
				actorKey: shell.actorKey,
				appShell: context.appShell,
				shellLocation: {
					pathname: location.pathname,
					searchStr: location.searchStr,
				},
				sentryConfig: shell.sentryConfig,
				canonicalOrigin: shell.canonicalOrigin,
				fathomSiteId: shell.fathomSiteId,
			}
		},
	},
	head: ({ loaderData }) => ({
		meta: [
			{ title: 'Kody' },
			...(loaderData?.sentryConfig
				? [
						{
							name: SENTRY_CONFIG_META_NAME,
							content: JSON.stringify(loaderData.sentryConfig),
						},
					]
				: []),
		],
		links: [],
	}),
	component: Root,
	errorComponent: ({ error }) => (
		<main id="main">
			{error instanceof Error && error.message === documentForbiddenMessage ? (
				<section data-testid="unauthorized-page" css={mainGutterPaddingCss}>
					<h1>Unauthorized</h1>
					<p>{documentForbiddenMessage}</p>
					<UnauthorizedAgentPrompt />
					<SiteLink href="/">Go home</SiteLink>
				</section>
			) : (
				<InternalErrorPage />
			)}
		</main>
	),
})

export function useShellData() {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const { shellLocation } = useLoaderData({ from: '__root__' })
	return useSuspenseQuery(shellQuery(actorKey, shellLocation.searchStr)).data
}

function Root() {
	const loaded = Route.useLoaderData()
	return loaded ? (
		<LoadedAppLayout />
	) : (
		<main id="main">
			<Outlet />
		</main>
	)
}

function LoadedAppLayout() {
	const { shellLocation, appShell } = Route.useLoaderData()
	const { session, youtubeWatch } = useShellData()
	const router = useRouter()
	const { queryClient, actorKey } = Route.useRouteContext()
	useEffect(
		() =>
			refreshOnActivation({
				window,
				document,
				refresh: async () => {
					try {
						await refreshActiveQueries(queryClient, actorKey, verifySession)
					} catch (error) {
						if (!isRedirect(error)) throw error
						await router.navigate(error.options)
						return
					}
				},
				onError: captureClientException,
			}),
		[actorKey, queryClient, router],
	)
	// Loader data commits with the displayed matches, unlike the pending URL.
	const pathname = shellLocation.pathname
	const previousPathname = useRef(pathname)
	useEffect(() => {
		if (previousPathname.current === pathname) return
		previousPathname.current = pathname
		const frame = requestAnimationFrame(() =>
			(
				document.querySelector<HTMLElement>('[data-docs-heading]') ??
				document.getElementById('main')
			)?.focus({ preventScroll: true }),
		)
		return () => cancelAnimationFrame(frame)
	}, [pathname])
	const illustratedError = useRouterState({
		select: (state) =>
			state.matches.some(
				(match) => match.status === 'notFound' || match.status === 'error',
			),
	})
	const authReturnHref = `${shellLocation.pathname}${shellLocation.searchStr}`
	const loginHref = buildAuthLink(
		'/login',
		appShell.preserveLoginReturn ? authReturnHref : null,
	)
	const authShell = appShell.mode === 'auth'
	const focused = appShell.mode === 'focused'
	return (
		<div data-app-frame css={appFrameCss}>
			<a href="#main" css={visuallyHiddenUntilFocusedCss}>
				Skip to content
			</a>
			{authShell ? null : (
				<SiteHeader
					focused={focused}
					loggedIn={session !== null}
					organizationSession={session}
					displayName={session?.username || session?.email || ''}
					username={session?.username ?? ''}
					avatarUrl={session?.avatarUrl ?? null}
					showAdminLink={session?.roles.includes('admin') ?? false}
					showDemoIndicator={session?.featureFlags?.['demo-indicator'] === true}
					loginHref={loginHref}
					currentPathname={pathname}
				/>
			)}
			<main
				id="main"
				tabIndex={-1}
				css={appMainCss(appShell, illustratedError)}
			>
				<Outlet />
			</main>
			{authShell || focused ? null : (
				<SiteFooter loggedIn={session !== null} loginHref={loginHref} />
			)}
			<YouTubeWatchOverlay snapshot={youtubeWatch} location={shellLocation} />
		</div>
	)
}

/** The document must render even when beforeLoad prevents every loader. */
function DocumentShell({ children }: { children: ReactNode }) {
	const nonce = useRouter().options.ssr?.nonce
	const homeDocument = useRouterState({
		select: (state) =>
			state.matches.some(
				(match) => match.routeId === '/' && match.status === 'success',
			),
	})
	const scarfTracker = useRef<ReturnType<typeof createScarfPageTracker> | null>(
		null,
	)
	const scarfLocation = useRouterState({
		select: (state) =>
			state.status === 'idle' ? state.resolvedLocation?.href : undefined,
	})

	const loaded = Route.useLoaderData()
	const failure = useRouterState({
		select: (state) => state.matches.find((match) => match.error)?.error,
	})
	useEffect(() => {
		if (failure || scarfLocation === undefined) return
		scarfTracker.current ??= createScarfPageTracker()
		scarfTracker.current()
	}, [scarfLocation, failure])
	const identity = isNotFound(failure)
		? failure.data
		: failure instanceof Error
			? failure.cause
			: undefined
	const actorKey = loaded
		? loaded.actorKey
		: identity &&
			  typeof identity === 'object' &&
			  'actorKey' in identity &&
			  typeof identity.actorKey === 'string'
			? identity.actorKey
			: null
	const failureHead = isNotFound(failure)
		? { title: NOT_FOUND_DOCUMENT_TITLE }
		: failure
			? {
					title:
						failure instanceof Error &&
						failure.message === documentForbiddenMessage
							? 'Unauthorized | Kody'
							: 'Something went wrong | Kody',
				}
			: undefined
	useEffect(() => {
		document.documentElement.dataset.hydrated = 'true'
	}, [])
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="utf-8" />
				{homeDocument ? (
					<script
						nonce={nonce}
						type="application/ld+json"
						dangerouslySetInnerHTML={{
							__html: homeSoftwareApplicationJsonLdScriptText(),
						}}
					/>
				) : null}
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<link rel="icon" href={publicAsset('/favicon.ico')} sizes="any" />
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href={publicAsset('/favicon-32x32.png')}
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="16x16"
					href={publicAsset('/favicon-16x16.png')}
				/>
				<link
					rel="apple-touch-icon"
					sizes="180x180"
					href={publicAsset('/apple-touch-icon.png')}
				/>
				<link rel="manifest" href={publicAsset('/site.webmanifest')} />
				<meta
					name="theme-color"
					content="#e6e8ea"
					media="(prefers-color-scheme: light)"
				/>
				<meta
					name="theme-color"
					content="#111417"
					media="(prefers-color-scheme: dark)"
				/>
				<script src={publicAsset('/page-init.js')} />
				<link
					rel="preload"
					as="font"
					type="font/woff2"
					href={publicAsset('/fonts/bricolage-grotesque-latin.woff2')}
					crossOrigin="anonymous"
				/>
				<link
					rel="preload"
					as="font"
					type="font/woff2"
					href={publicAsset('/fonts/wix-madefor-text-latin.woff2')}
					crossOrigin="anonymous"
				/>
				{loaded?.canonicalOrigin ? (
					<meta
						name={CANONICAL_ORIGIN_META_NAME}
						content={loaded.canonicalOrigin}
					/>
				) : null}
				<meta name={documentActorMetaName} content={JSON.stringify(actorKey)} />
				<PageHead overrideHead={failureHead} />
				<FathomTracker siteId={loaded?.fathomSiteId} />
			</head>
			<body>
				<AppBrowserEffects />
				{children}
				<Toaster />
				<Scripts />
			</body>
		</html>
	)
}

function UnauthorizedAgentPrompt() {
	const pathname = useLocation({ select: (location) => location.pathname })
	return (
		<ErrorAgentPromptButton
			prompt={buildUnauthorizedErrorAgentPrompt({ path: pathname })}
		/>
	)
}

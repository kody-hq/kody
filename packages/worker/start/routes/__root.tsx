/** @jsxImportSource @emotion/react */
import { homeSoftwareApplicationJsonLdScriptText } from '#universal/home-json-ld.ts'
import { workspaceLayoutNavigation } from '../workspace-layout-policy.ts'
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
	useMatches,
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
import { isBrowserFetchNetworkError } from '#client/browser-fetch-network-error.ts'
import { captureClientException } from '#client/sentry-client.ts'
import { CANONICAL_ORIGIN_META_NAME } from '#universal/document-head-markers.ts'
import {
	documentCharset,
	documentViewport,
	documentThemeColors,
} from '../document-shell-meta.ts'
import { SENTRY_CONFIG_META_NAME } from '#universal/sentry-config.ts'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { RouteErrorPage } from '../components/route-error-page.tsx'
import { isPermissionDeniedError } from '#universal/permission-denied.ts'
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
import 'tw-fade/dist/tw-fade.css'
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
				inPlaceNavigation: false,
			}
		}
		const actorKey = parseDocumentActor(readDocumentActor())
		const inPlaceNavigation = isPresentationNavigation({
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
			inPlaceNavigation,
			verifyAccess:
				!preload && requiresSessionVerification(matches) && !inPlaceNavigation,
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
					context.orgScope?.orgSlug ?? null,
					!context.inPlaceNavigation,
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
				<RouteErrorPage error={error} />
			)}
		</main>
	),
})

export function useShellData() {
	const { actorKey, orgScope } = useRouteContext({ from: '__root__' })
	const { shellLocation } = useLoaderData({ from: '__root__' })
	return useSuspenseQuery(
		shellQuery(actorKey, shellLocation.searchStr, orgScope?.orgSlug ?? null),
	).data
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
	const { queryClient, actorKey, pageNavigation, pageLocation } =
		Route.useRouteContext()
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
				// Activation only hits Start serverFns (verifySession + page
				// queries). Transient fetch TypeErrors are expected when a
				// slept tab resumes offline (KODY-9Q); keep stale Query data
				// and skip Sentry — beforeSend also filters via /_serverFn
				// breadcrumbs when capture comes from elsewhere.
				onError: (error) => {
					if (isBrowserFetchNetworkError(error)) return
					captureClientException(error)
				},
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
	const authReturnHref = `${pageLocation.pathname}${pageLocation.searchStr}`
	const loginHref = buildAuthLink(
		'/login',
		appShell.preserveLoginReturn ? authReturnHref : null,
	)
	const signupHref = buildAuthLink(
		'/signup',
		appShell.preserveLoginReturn ? authReturnHref : null,
	)
	const authShell = appShell.mode === 'auth'
	const focused = appShell.mode === 'focused'
	const workspace = Boolean(workspaceLayoutNavigation(useMatches(), session))
	const Content = workspace ? 'div' : 'main'
	return (
		<div
			data-app-frame
			data-app-interface={pageNavigation ? '' : undefined}
			css={appFrameCss}
		>
			<a href="#main" css={visuallyHiddenUntilFocusedCss}>
				Skip to content
			</a>
			{authShell || workspace ? null : (
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
			<Content
				id={workspace ? undefined : 'main'}
				tabIndex={-1}
				css={
					workspace
						? { width: '100%', flex: 1 }
						: appMainCss(appShell, illustratedError)
				}
			>
				<Outlet />
			</Content>
			{authShell || focused || workspace ? null : (
				<SiteFooter
					loggedIn={session !== null}
					loginHref={loginHref}
					signupHref={signupHref}
				/>
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
							: isPermissionDeniedError(failure)
								? 'Access denied | Kody'
								: 'Something went wrong | Kody',
				}
			: undefined
	useEffect(() => {
		document.documentElement.dataset.hydrated = 'true'
	}, [])
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet={documentCharset} />
				{homeDocument ? (
					<script
						nonce={nonce}
						type="application/ld+json"
						dangerouslySetInnerHTML={{
							__html: homeSoftwareApplicationJsonLdScriptText(),
						}}
					/>
				) : null}
				<meta name="viewport" content={documentViewport} />
				{/* Transparent edge-to-edge mark (no plate): outlined black for light
				    OS chrome, solid white for dark. Order matters: Chromium ignores
				    `media` on icon links and picks the last best match, so the ICO
				    is sized (not `any`) and the scheme-aware SVG comes last.
				    Follows the OS preference, not the in-app theme. */}
				<link rel="icon" href={publicAsset('/favicon.ico')} sizes="32x32" />
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href={publicAsset('/favicon-32x32.png')}
					media="(prefers-color-scheme: light)"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="16x16"
					href={publicAsset('/favicon-16x16.png')}
					media="(prefers-color-scheme: light)"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href={publicAsset('/favicon-32x32-dark.png')}
					media="(prefers-color-scheme: dark)"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="16x16"
					href={publicAsset('/favicon-16x16-dark.png')}
					media="(prefers-color-scheme: dark)"
				/>
				<link
					rel="icon"
					type="image/svg+xml"
					href={publicAsset('/favicon.svg')}
				/>
				<link
					rel="apple-touch-icon"
					sizes="180x180"
					href={publicAsset('/apple-touch-icon.png')}
				/>
				<link rel="manifest" href={publicAsset('/site.webmanifest')} />
				{/* Extensions (e.g. Dark Reader) often rewrite the first theme-color
				    content before hydrate. Keep validating other head metas. */}
				<meta
					name="theme-color"
					{...documentThemeColors.light}
					suppressHydrationWarning
				/>
				<meta
					name="theme-color"
					{...documentThemeColors.dark}
					suppressHydrationWarning
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
				{/* Classic script: hoist Emotion SSR styles before module hydrate. */}
				<script src={publicAsset('/emotion-style-hoist.js')} />
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

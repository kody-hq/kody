/** @jsxImportSource react */
import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { hydrateStart } from '@tanstack/react-start/client'
import { RouterProvider, type AnyRouter } from '@tanstack/react-router'
import { documentHydrationDiagnostics } from './document-hydration-diagnostics.ts'
import { documentMetaDiagnostics } from './document-meta-diagnostics.ts'
import {
	clearStaleRouteChunkReloadFlag,
	onVitePreloadError,
	setStaleRouteChunkReloadArmed,
} from '#client/reload-on-stale-route-chunk.ts'
import { clearDeploySkewReloadFlag } from '#client/reload-on-deploy-skew.ts'
import {
	captureClientException,
	initSentryClient,
	type ClientErrorContext,
} from '#client/sentry-client.ts'
import { captureFirstTouchAttributionFromLocation } from '#client/first-touch-attribution.ts'
import { persistReferralCookieFromLocation } from '#client/referral-cookie.ts'
import { scheduleConsumeAccountCreatedFathomSignal } from '#client/fathom-events.ts'
import { locationWithoutHomeOgParam } from '#universal/home-og-variants.ts'
import { createScarfPageTracker } from '#client/scarf-analytics.ts'
import { syncSidebarViewportWithRouter } from './components/sidebar-preferences.tsx'
import { isPermissionDeniedError } from '#universal/permission-denied.ts'

initSentryClient(document)
window.addEventListener('vite:preloadError', onVitePreloadError)

function reportReactError(error: unknown, context?: ClientErrorContext) {
	if (!isPermissionDeniedError(error))
		console.error('React client error:', error)
	captureClientException(error, context)
}

function clearReloadFlagsAfterSuccessfulHydration(router: AnyRouter) {
	// A failed recovery must retain the one-shot flag across another reload.
	if (
		router.state.matches.length > 0 &&
		router.state.matches.every((match) => match.status === 'success')
	) {
		clearDeploySkewReloadFlag()
		clearStaleRouteChunkReloadFlag()
	}
}

function startBrowserLocationEffects(router: AnyRouter) {
	scheduleConsumeAccountCreatedFathomSignal({
		replaceHref: (next) =>
			router.history.replace(next, router.history.location.state),
	})
	// Signup clears the first-touch cookie; a signed-in page must not recreate it.
	let signedOut = false
	const sync = () => {
		const nextSignedOut =
			(router.state.matches[0]?.context as { actorKey?: unknown } | undefined)
				?.actorKey === null
		if (nextSignedOut && !signedOut) captureFirstTouchAttributionFromLocation()
		signedOut = nextSignedOut
		persistReferralCookieFromLocation()
		const next = locationWithoutHomeOgParam(window.location.href)
		if (next) router.history.replace(next, router.history.location.state)
	}
	sync()
	router.subscribe('onResolved', sync)
	const trackScarfPage = createScarfPageTracker()
	let scarfHref: string | undefined
	const trackPage = () => {
		const href = router.state.resolvedLocation?.href
		if (
			!href ||
			href === scarfHref ||
			router.state.matches.some((match) => match.error)
		)
			return
		scarfHref = href
		trackScarfPage()
	}
	trackPage()
	router.subscribe('onResolved', trackPage)
	let focusFrame = 0
	router.subscribe('onResolved', ({ pathChanged }) => {
		if (!pathChanged) return
		cancelAnimationFrame(focusFrame)
		const fileColumnNavigation =
			router.state.resolvedLocation?.state.fileColumnNavigation
		focusFrame = requestAnimationFrame(() => {
			if (
				fileColumnNavigation &&
				document.activeElement?.closest('[data-file-column-browser]')
			)
				return
			const target =
				document.querySelector<HTMLElement>('[data-docs-heading]') ??
				document.getElementById('main')
			target?.focus({ preventScroll: true })
		})
	})
}

hydrateStart()
	.then((router) => {
		clearReloadFlagsAfterSuccessfulHydration(router)
		startBrowserLocationEffects(router)
		syncSidebarViewportWithRouter(router)
		// Arm only while a route load is in flight. Chunk import rejection and
		// the route error boundary both run before `onResolved`.
		router.subscribe('onBeforeLoad', () => {
			setStaleRouteChunkReloadArmed(true)
		})
		router.subscribe('onResolved', () => {
			setStaleRouteChunkReloadArmed(false)
		})
		const reportDocumentError = (
			error: unknown,
			context?: ClientErrorContext,
		) => {
			let enriched = context
			if (
				error instanceof Error &&
				error.message.startsWith('Hydration mismatch')
			) {
				try {
					if (/at meta\s+at head\b/.test(context?.componentStack ?? '')) {
						enriched = {
							...context,
							documentMeta: documentMetaDiagnostics(
								document,
								router.state.matches[0]?.loaderData,
							),
						}
					} else {
						// Structural mismatch (reconcile leftover / adoptHostDom).
						enriched = {
							...context,
							documentHydration: documentHydrationDiagnostics(document),
						}
					}
				} catch {
					// Diagnostics must never prevent the original error report.
				}
			}
			reportReactError(error, enriched)
		}
		startTransition(() => {
			hydrateRoot(
				document,
				<StrictMode>
					<RouterProvider router={router} />
				</StrictMode>,
				{
					onCaughtError: reportDocumentError,
					onUncaughtError: reportDocumentError,
					onRecoverableError: reportDocumentError,
				},
			)
		})
	})
	.catch(reportReactError)

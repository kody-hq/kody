/** @jsxImportSource react */
import { StrictMode, startTransition, useEffect } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { hydrateStart } from '@tanstack/react-start/client'
import { RouterProvider, type AnyRouter } from '@tanstack/react-router'
import { documentMetaDiagnostics } from './document-meta-diagnostics.ts'
import { documentHydrationDiagnostics } from './document-hydration-diagnostics.ts'
import { clearUnknownStartReleaseReloadFlag } from '#client/reload-on-unknown-start-release.ts'
import {
	captureClientException,
	initSentryClient,
	type ClientErrorContext,
} from '#client/sentry-client.ts'

initSentryClient(document)

function reportReactError(error: unknown, context?: ClientErrorContext) {
	console.error('React client error:', error)
	captureClientException(error, context)
}

function HydratedApp({ router }: { router: AnyRouter }) {
	useEffect(() => {
		// A failed recovery must retain the one-shot flag across another reload.
		if (
			router.state.matches.length > 0 &&
			router.state.matches.every((match) => match.status === 'success')
		)
			clearUnknownStartReleaseReloadFlag()
	}, [router])
	return <RouterProvider router={router} />
}

hydrateStart()
	.then((router) => {
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
					<HydratedApp router={router} />
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

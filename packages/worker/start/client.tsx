/** @jsxImportSource react */
import { StrictMode, startTransition, useEffect } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { hydrateStart } from '@tanstack/react-start/client'
import { RouterProvider, type AnyRouter } from '@tanstack/react-router'
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
		startTransition(() => {
			hydrateRoot(
				document,
				<StrictMode>
					<HydratedApp router={router} />
				</StrictMode>,
				{
					onCaughtError: reportReactError,
					onUncaughtError: reportReactError,
					onRecoverableError: reportReactError,
				},
			)
		})
	})
	.catch(reportReactError)

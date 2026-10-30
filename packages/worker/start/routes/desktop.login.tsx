/** @jsxImportSource @emotion/react */
import { AuthLayout } from '../components/auth-layout.tsx'
import { getPrimaryButtonCss } from '#universal/styles/style-primitives.ts'
import { parseDesktopAuthRequest } from '#app/desktop-auth-request.ts'
import { createFileRoute } from '@tanstack/react-router'
import { useHydrated } from '../components/use-hydrated.ts'
import { useState } from 'react'
import {
	loadDesktopLogin,
	approveDesktopLogin,
} from '#start/server/desktop-auth'
export const Route = createFileRoute('/desktop/login')({
	staticData: { shell: { mode: 'auth' }, documentNavigation: true },
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		loadDesktopLogin({
			data: parseDesktopAuthRequest(
				Object.fromEntries(new URLSearchParams(location.searchStr)),
			),
		}),
	component: DesktopLogin,
})
function DesktopLogin() {
	const { email, personId } = Route.useLoaderData()
	const hydrated = useHydrated()
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const [done, setDone] = useState(false)
	return (
		<AuthLayout title="Sign in to Kody desktop">
			{done ? (
				<p>You can return to Kody.</p>
			) : (
				<>
					<p>Continue as {email}</p>
					<p>Only continue if you opened sign-in from Kody on this computer.</p>
					<button
						css={getPrimaryButtonCss()}
						disabled={busy || !hydrated}
						onClick={async () => {
							setBusy(true)
							setError('')
							try {
								const { callback } = await approveDesktopLogin({
									data: {
										...parseDesktopAuthRequest(
											Object.fromEntries(
												new URLSearchParams(window.location.search),
											),
										),
										personId,
									},
								})
								setDone(true)
								window.location.assign(callback)
							} catch (error) {
								setError(
									error instanceof Error ? error.message : 'Could not sign in.',
								)
								setBusy(false)
							}
						}}
					>
						{busy ? 'Connecting…' : 'Continue to Kody desktop'}
					</button>
					{error && <p role="alert">{error}</p>}
				</>
			)}
		</AuthLayout>
	)
}

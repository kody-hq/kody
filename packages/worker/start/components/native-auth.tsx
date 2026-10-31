/** @jsxImportSource @emotion/react */
import { AuthLayout } from './auth-layout.tsx'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type {} from '../desktop-shell.ts'
const subscribe = () => () => {}
export function NativeAuth({
	mode,
	children,
}: {
	mode: 'login' | 'signup'
	children: ReactNode
}) {
	const auth = useSyncExternalStore(
		subscribe,
		() => window.kodyDesktop?.authentication,
		() => undefined,
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	if (!auth) return children
	return (
		<AuthLayout
			title={mode === 'signup' ? 'Create your account' : 'Welcome back'}
		>
			<button
				css={getPrimaryButtonCss()}
				disabled={busy}
				onClick={async () => {
					setBusy(true)
					setError('')
					try {
						await auth.signIn(mode)
					} catch (error) {
						setError(
							error instanceof Error ? error.message : 'Could not sign in.',
						)
					} finally {
						setBusy(false)
					}
				}}
			>
				{busy ? 'Waiting for your browser…' : 'Continue in your browser'}
			</button>
			{busy && (
				<button
					css={getSecondaryButtonCss()}
					onClick={() => void auth.cancel()}
				>
					Cancel
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</AuthLayout>
	)
}

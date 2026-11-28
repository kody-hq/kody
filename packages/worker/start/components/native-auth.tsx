/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import { AuthLayout } from './auth-layout.tsx'
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
			visitor={mode === 'signup' ? 'new' : 'returning'}
		>
			<Button
				variant="primary"
				size="md"
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
			</Button>
			{busy && (
				<Button
					variant="secondary"
					size="md"
					onClick={() => void auth.cancel()}
				>
					Cancel
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
		</AuthLayout>
	)
}

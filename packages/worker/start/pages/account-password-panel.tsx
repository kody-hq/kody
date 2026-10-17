/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useHydrated } from '../components/use-hydrated.ts'
import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { SiteLink } from '../components/site-link.tsx'
import { toast } from '#client/toast.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { changePassword } from '#start/server/security-mutations'
import { minPasswordLength } from '@kody-internal/shared/password-policy.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

type PasswordStatus = 'idle' | 'saving'

export function AccountPasswordPanel(props: {
	hasUsablePassword: boolean
	onPasswordSet: () => void
}) {
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
	})
	const { actorKey } = useMatchedPageScope()
	const href = useMatchedPageScope().pageLocation.href
	const scope = useRef<object | null>(null)
	useEffect(() => {
		scope.current = {}
		return () => {
			scope.current = null
		}
	}, [actorKey, href])
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: (data: { currentPassword?: string; newPassword: string }) =>
			changePassword({ data }),
		onMutate: () => invalidatePages,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})

	const hydrated = useHydrated()
	const [currentPassword, setCurrentPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [status, setStatus] = useState<PasswordStatus>('idle')
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'error' | 'info'>('info')

	function updateCurrentPassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setCurrentPassword(event.currentTarget.value)
	}

	function updateNewPassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setNewPassword(event.currentTarget.value)
	}

	function updateConfirmPassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setConfirmPassword(event.currentTarget.value)
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (props.hasUsablePassword && !currentPassword) {
			setMessage('Current password is required.')
			setMessageTone('error')
			return
		}
		if (!newPassword || !confirmPassword) {
			setMessage('New password and confirmation are required.')
			setMessageTone('error')
			return
		}
		if (newPassword !== confirmPassword) {
			setMessage('New password and confirmation do not match.')
			setMessageTone('error')
			return
		}

		setStatus('saving')
		setMessage(null)
		setMessageTone('info')

		const submittedScope = scope.current
		try {
			const payload = await mutation.mutateAsync({
				...(props.hasUsablePassword ? { currentPassword } : {}),
				newPassword,
			})
			if (!submittedScope || scope.current !== submittedScope) return
			if (!payload.ok)
				throw new Error(payload.error || 'Unable to update your password.')
			setCurrentPassword('')
			setNewPassword('')
			setConfirmPassword('')
			setMessage(payload.message ?? 'Password updated.')
			setMessageTone('info')
			if (!props.hasUsablePassword) {
				props.onPasswordSet()
			}
			toast.success('Password updated.')
		} catch (error) {
			if (!submittedScope || scope.current !== submittedScope) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update your password.',
			)
			setMessageTone('error')
		} finally {
			if (submittedScope && scope.current === submittedScope) setStatus('idle')
		}
	}

	{
		const hasUsablePassword = props.hasUsablePassword
		const isSaving = status === 'saving'
		const title = hasUsablePassword ? 'Change password' : 'Set a password'
		const canSubmit =
			newPassword.length > 0 &&
			confirmPassword.length > 0 &&
			(!hasUsablePassword || currentPassword.length > 0)

		return (
			<AccountManagementPanel
				title="Sign-in"
				description="Change your password, add two-factor authentication, or sign in with passkeys."
			>
				<details css={accountDisclosureCss}>
					<summary>{title}</summary>
					<form
						method="post"
						data-testid="account-password-form"
						css={{
							display: 'grid',
							gap: spacing.md,
							maxWidth: '26rem',
						}}
						onSubmit={handleSubmit}
					>
						<p css={accountFieldNoteCss}>
							{hasUsablePassword
								? 'Other browser sessions and connected MCP hosts will need to sign in again.'
								: 'This account signs in with a connected provider or passkey. Setting a password lets you also sign in with email.'}
						</p>
						{hasUsablePassword ? (
							<label css={accountFieldCss}>
								<span css={accountFieldLabelCss}>Current password</span>
								<input
									type="password"
									name="currentPassword"
									data-field-ring
									required
									autoComplete="current-password"
									value={currentPassword}
									css={accountInputCss}
									onInput={updateCurrentPassword}
								/>
							</label>
						) : null}
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>New password</span>
							<input
								type="password"
								name="newPassword"
								data-field-ring
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								placeholder={`At least ${minPasswordLength} characters`}
								value={newPassword}
								css={accountInputCss}
								onInput={updateNewPassword}
							/>
						</label>
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>Confirm new password</span>
							<input
								type="password"
								name="confirmPassword"
								data-field-ring
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								value={confirmPassword}
								css={accountInputCss}
								onInput={updateConfirmPassword}
							/>
						</label>
						<div>
							<button
								type="submit"
								disabled={!hydrated || isSaving || !canSubmit}
								css={compactPillButtonCss}
							>
								{isSaving
									? 'Saving...'
									: hasUsablePassword
										? 'Update password'
										: 'Set password'}
							</button>
						</div>
						{message ? (
							<p
								role="status"
								css={{
									color: messageTone === 'error' ? colors.error : colors.text,
									margin: 0,
								}}
							>
								{message}
							</p>
						) : null}
					</form>
				</details>
				<div css={accountActionsCss}>
					<SiteLink href="/account/two-factor" css={compactGhostButtonCss}>
						Two-factor authentication
					</SiteLink>
					<SiteLink href="/account/passkeys" css={compactGhostButtonCss}>
						Passkeys
					</SiteLink>
				</div>
			</AccountManagementPanel>
		)
	}
}

const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const mutationResources = ['loadAccountPage'] as const

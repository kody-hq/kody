/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { fieldDescriptionCss } from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import { useActorRef } from '@xstate/react'
import { submissionGateState } from '#client/routes/submission-gate-state.ts'
import { createUiFeedback, type UiFeedback } from '#client/ui-feedback.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useHydrated } from '../components/use-hydrated.ts'
import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from '#client/toast.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { changePassword } from '#start/server/security-mutations'
import { minPasswordLength } from '@kody-internal/shared/password-policy.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { Input } from '../components/input.tsx'
export function AccountPasswordPanel(props: {
	hasUsablePassword: boolean
	onPasswordSet: () => void
}) {
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
	})
	const captureScope = useSubmitterScope()
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: async (data: {
			currentPassword?: string
			newPassword: string
		}) => {
			const payload = await changePassword({ data })
			if (!payload.ok)
				throw new Error(payload.error || 'Unable to update your password.')
			return payload
		},
		onMutate: () => invalidatePages,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})

	const hydrated = useHydrated()
	const [currentPassword, setCurrentPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const runExclusiveActor = useActorRef(submissionGateState)
	const [feedback, setFeedback] = useState<UiFeedback | null>(() =>
		createUiFeedback(null, 'info'),
	)
	const message = feedback?.message ?? null
	const messageTone = feedback?.tone ?? 'info'

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
		if (!runExclusiveActor.getSnapshot().can({ type: 'SUBMIT' })) return
		runExclusiveActor.send({ type: 'SUBMIT' })
		try {
			return await (async () => {
				if (props.hasUsablePassword && !currentPassword) {
					setFeedback(
						createUiFeedback('Current password is required.', 'error'),
					)
					return
				}
				if (!newPassword || !confirmPassword) {
					setFeedback(
						createUiFeedback(
							'New password and confirmation are required.',
							'error',
						),
					)
					return
				}
				if (newPassword !== confirmPassword) {
					setFeedback(
						createUiFeedback(
							'New password and confirmation do not match.',
							'error',
						),
					)
					return
				}

				setFeedback(createUiFeedback(null, 'info'))

				const isSubmissionCurrent = captureScope()
				try {
					const payload = await mutation.mutateAsync({
						...(props.hasUsablePassword ? { currentPassword } : {}),
						newPassword,
					})
					if (!isSubmissionCurrent()) return
					setCurrentPassword('')
					setNewPassword('')
					setConfirmPassword('')
					setFeedback(
						createUiFeedback(payload.message ?? 'Password updated.', 'info'),
					)
					if (!props.hasUsablePassword) {
						props.onPasswordSet()
					}
					toast.success('Password updated.')
				} catch (error) {
					if (!isSubmissionCurrent()) return
					setFeedback(
						createUiFeedback(
							error instanceof Error
								? error.message
								: 'Unable to update your password.',
							'error',
						),
					)
				}
			})()
		} finally {
			runExclusiveActor.send({ type: 'SETTLED' })
		}
	}

	{
		const hasUsablePassword = props.hasUsablePassword
		const isSaving = mutation.isPending
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
						aria-busy={isSaving}
						method="post"
						data-testid="account-password-form"
						css={{
							display: 'grid',
							gap: spacing.md,
							maxWidth: '26rem',
						}}
						onSubmit={handleSubmit}
					>
						<p css={fieldDescriptionCss}>
							{hasUsablePassword
								? 'Other browser sessions and connected MCP hosts will need to sign in again.'
								: 'This account signs in with a connected provider or passkey. Setting a password lets you also sign in with email.'}
						</p>
						{hasUsablePassword ? (
							<Field label="Current password">
								<Input
									type="password"
									name="currentPassword"
									required
									autoComplete="current-password"
									value={currentPassword}
									onInput={updateCurrentPassword}
								/>
							</Field>
						) : null}
						<Field label="New password">
							<Input
								type="password"
								name="newPassword"
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								placeholder={`At least ${minPasswordLength} characters`}
								value={newPassword}
								onInput={updateNewPassword}
							/>
						</Field>
						<Field label="Confirm new password">
							<Input
								type="password"
								name="confirmPassword"
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								value={confirmPassword}
								onInput={updateConfirmPassword}
							/>
						</Field>
						<div>
							<Button
								type="submit"
								disabled={!hydrated || isSaving || !canSubmit}
								variant="primary"
							>
								{isSaving
									? 'Saving...'
									: hasUsablePassword
										? 'Update password'
										: 'Set password'}
							</Button>
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
					<Button href="/account/two-factor" variant="secondary">
						Two-factor authentication
					</Button>
					<Button href="/account/passkeys" variant="secondary">
						Passkeys
					</Button>
				</div>
			</AccountManagementPanel>
		)
	}
}

const mutationResources = ['loadAccountPage'] as const

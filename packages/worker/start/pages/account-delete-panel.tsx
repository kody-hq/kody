/** @jsxImportSource @emotion/react */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { type CSSObject } from '@emotion/react'
import { useState, useRef, type FormEvent } from 'react'
import {
	accountDeletedHomePath,
	accountDeletionConfirmationPhrase,
} from '#universal/account-deletion-confirmation.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { deleteOwnAccount } from '#start/server/security-mutations'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'

export function AccountDeletePanel(props: { hasUsablePassword: boolean }) {
	const [confirmation, setConfirmation] = useState('')
	const [password, setPassword] = useState('')
	const queryClient = useQueryClient()
	const dialogNode = useRef<HTMLDialogElement>(null)

	function closeDialog() {
		if (deletion.isPending) return
		setConfirmation('')
		setPassword('')
		deletion.reset()
		dialogNode.current?.close()
	}

	function openDialog() {
		setConfirmation('')
		setPassword('')
		deletion.reset()
		dialogNode.current?.showModal()
	}

	function updateConfirmation(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setConfirmation(event.currentTarget.value)
	}

	function updatePassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setPassword(event.currentTarget.value)
	}

	const deletion = useMutation({
		retry: false,
		mutationFn: async (input: { confirmation: string; password?: string }) => {
			const payload = await deleteOwnAccount({ data: input })
			if ('error' in payload) throw new Error(payload.error)

			return accountDeletedHomePath()
		},
		onSuccess: async (href) => {
			// Stop outstanding reads before discarding the signed-in browser cache.
			await queryClient.cancelQueries()
			queryClient.clear()
			window.location.assign(href)
		},
	})

	function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (
			deletion.isPending ||
			confirmation.trim() !== accountDeletionConfirmationPhrase ||
			(props.hasUsablePassword && !password)
		)
			return
		deletion.mutate({
			confirmation,
			...(props.hasUsablePassword ? { password } : {}),
		})
	}

	{
		const isDeleting = deletion.isPending
		const error = deletion.error?.message
		const confirmationMatches =
			confirmation.trim() === accountDeletionConfirmationPhrase
		const canSubmit =
			confirmationMatches &&
			(!props.hasUsablePassword || password.length > 0) &&
			!isDeleting

		return (
			<>
				<div css={{ display: 'grid', gap: spacing.md, maxWidth: '36rem' }}>
					<p css={accountFieldNoteCss}>
						This permanently deletes your account, packages, jobs, email,
						secrets, and stored data. Download an export first if you want a
						copy.
					</p>
					<div css={accountActionsCss}>
						<button
							type="button"
							data-testid="delete-account"
							css={getDangerPillCss({ size: 'sm' })}
							onClick={openDialog}
						>
							Delete account
						</button>
					</div>
				</div>
				<dialog
					aria-labelledby="delete-account-title"
					data-testid="delete-account-dialog"
					ref={dialogNode}
					css={deleteDialogCss}
					onCancel={(event) => {
						event.preventDefault()
						closeDialog()
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) closeDialog()
					}}
				>
					<form
						method="dialog"
						css={deleteDialogFormCss}
						onSubmit={handleDeleteSubmit}
					>
						<h3 id="delete-account-title" css={deleteDialogTitleCss}>
							Delete your Kody account?
						</h3>
						<div
							css={getAccentCalloutCss({
								accentColor: colors.error,
							})}
						>
							<p css={{ margin: 0 }}>
								This cannot be undone. Type{' '}
								<strong>{accountDeletionConfirmationPhrase}</strong> to confirm.
							</p>
						</div>
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>
								Type {accountDeletionConfirmationPhrase}
							</span>
							<input
								type="text"
								name="confirmation"
								data-testid="delete-account-confirmation"
								data-field-ring
								autoComplete="off"
								spellCheck={false}
								required
								value={confirmation}
								css={accountInputCss}
								onInput={updateConfirmation}
							/>
						</label>
						{props.hasUsablePassword ? (
							<div css={accountFieldCss}>
								<label
									htmlFor="delete-account-current-password"
									css={accountFieldLabelCss}
								>
									Current password
								</label>
								<PasswordRevealInput
									id="delete-account-current-password"
									name="password"
									data-testid="delete-account-password"
									data-field-ring
									required
									{...passwordManagerIgnoreProps}
									value={password}
									css={accountInputCss}
									onInput={updatePassword}
								/>
							</div>
						) : null}
						{error ? (
							<p
								role="alert"
								css={{
									margin: 0,
									color: colors.error,
									fontSize: typography.fontSize.sm,
								}}
							>
								{error}
							</p>
						) : null}
						<div css={accountActionsCss}>
							<button
								type="button"
								disabled={isDeleting}
								css={getGhostButtonCss({ size: 'sm' })}
								onClick={closeDialog}
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={!canSubmit}
								data-testid="delete-account-confirm"
								css={getDangerPillCss({ size: 'sm' })}
							>
								{isDeleting ? 'Deleting…' : 'Delete account'}
							</button>
						</div>
					</form>
				</dialog>
			</>
		)
	}
}

const deleteDialogCss: CSSObject = {
	width: 'min(32rem, calc(100vw - 2rem))',
	maxWidth: '32rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
}

const deleteDialogFormCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
}

const deleteDialogTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

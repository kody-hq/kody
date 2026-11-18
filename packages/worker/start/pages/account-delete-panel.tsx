/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { Dialog } from '../components/dialog.tsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import type { CSSObject } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import {
	accountDeletedHomePath,
	accountDeletionConfirmationPhrase,
} from '#universal/account-deletion-confirmation.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { deleteOwnAccount } from '#start/server/security-mutations'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	fieldCss,
	fieldLabelCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { accountActionsCss } from './account-management-components.tsx'
import { Input } from '../components/input.tsx'

export function AccountDeletePanel(props: { hasUsablePassword: boolean }) {
	const [confirmation, setConfirmation] = useState('')
	const [password, setPassword] = useState('')
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)

	function closeDialog() {
		if (deletion.isPending) return
		setConfirmation('')
		setPassword('')
		deletion.reset()
		setOpen(false)
	}

	function openDialog() {
		setConfirmation('')
		setPassword('')
		deletion.reset()
		setOpen(true)
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
					<p css={fieldDescriptionCss}>
						This permanently deletes your account, packages, jobs, email,
						secrets, and stored data. Download an export first if you want a
						copy.
					</p>
					<div css={accountActionsCss}>
						<Button
							type="button"
							data-testid="delete-account"
							variant="danger"
							onClick={openDialog}
						>
							Delete account
						</Button>
					</div>
				</div>
				{open && (
					<Dialog
						open
						role="alertdialog"
						flush
						aria-label="Delete your Kody account?"
						size="md"
						data-testid="delete-account-dialog"
						onClose={closeDialog}
					>
						<form css={deleteDialogFormCss} onSubmit={handleDeleteSubmit}>
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
									<strong>{accountDeletionConfirmationPhrase}</strong> to
									confirm.
								</p>
							</div>
							<Field label={<>Type {accountDeletionConfirmationPhrase}</>}>
								<Input
									type="text"
									name="confirmation"
									data-testid="delete-account-confirmation"
									autoComplete="off"
									spellCheck={false}
									required
									value={confirmation}
									onInput={updateConfirmation}
								/>
							</Field>
							{props.hasUsablePassword ? (
								<div css={fieldCss}>
									<label
										htmlFor="delete-account-current-password"
										css={fieldLabelCss}
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
								<Button
									type="button"
									disabled={isDeleting}
									variant="secondary"
									onClick={closeDialog}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									disabled={!canSubmit}
									data-testid="delete-account-confirm"
									variant="danger"
								>
									{isDeleting ? 'Deleting…' : 'Delete account'}
								</Button>
							</div>
						</form>
					</Dialog>
				)}
			</>
		)
	}
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

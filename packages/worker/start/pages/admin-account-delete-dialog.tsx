/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import { ModalDialog } from '../components/modal-dialog.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSObject } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import {
	deleteAdminUserAccount,
	readAdminAccountDeletionSummary,
} from '#start/server/admin-account-deletion'
import { canConfirmAdminAccountDeletion } from '#universal/admin-account-deletion.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountInputCss,
} from './account-management-components.tsx'
import { AdminAccountDeletionSummaryList } from './admin-account-deletion-summary.tsx'

export function AdminUserAccountModeration(props: {
	stableUserId: string
	username: string
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
	parentMutating: boolean
	onSubmitModerationAction: (
		action: 'suspend_user' | 'unsuspend_user' | 'resume_email_outbound',
	) => void
	onDeleted: (handle: string) => void
}) {
	const [open, setOpen] = useState(false)
	const [typedHandle, setTypedHandle] = useState('')
	const [acknowledged, setAcknowledged] = useState(false)

	const summaryQuery = useQuery({
		queryKey: ['admin-account-deletion-summary', props.stableUserId],
		enabled: open,
		queryFn: async () => {
			const payload = await readAdminAccountDeletionSummary({
				data: { stableUserId: props.stableUserId },
			})
			return payload.summary
		},
	})

	const deletion = useMutation({
		retry: false,
		mutationFn: async (input: {
			typedHandle: string
			acknowledged: boolean
		}) => {
			const payload = await deleteAdminUserAccount({
				data: {
					stableUserId: props.stableUserId,
					handleConfirmation: input.typedHandle,
					acknowledge: input.acknowledged,
				},
			})
			return payload.handle
		},
		onSuccess: (handle) => {
			closeDialog()
			props.onDeleted(handle)
		},
	})

	function closeDialog() {
		if (deletion.isPending) return
		setOpen(false)
		setTypedHandle('')
		setAcknowledged(false)
		deletion.reset()
	}

	function openDialog() {
		setTypedHandle('')
		setAcknowledged(false)
		deletion.reset()
		setOpen(true)
	}

	const summary = summaryQuery.data
	const pending = deletion.isPending || props.parentMutating
	const canDelete = summary
		? canConfirmAdminAccountDeletion({
				handle: summary.handle,
				typedHandle,
				acknowledgementRequired: summary.acknowledgementRequired,
				acknowledged,
				pending: pending || Boolean(summary.deletionBlocked),
			})
		: false

	return (
		<>
			<div
				css={{
					display: 'flex',
					gap: spacing.md,
					flexWrap: 'wrap',
				}}
			>
				{props.suspendedAt ? (
					<Button
						type="button"
						disabled={pending}
						onClick={() => props.onSubmitModerationAction('unsuspend_user')}
						variant="primary"
					>
						{props.parentMutating ? 'Working…' : 'Clear suspension'}
					</Button>
				) : (
					<Button
						type="button"
						disabled={pending}
						data-testid="admin-suspend-account"
						onClick={() => props.onSubmitModerationAction('suspend_user')}
						variant="secondary"
					>
						{props.parentMutating ? 'Working…' : 'Suspend account'}
					</Button>
				)}
				<Button
					type="button"
					disabled={pending}
					data-testid="admin-delete-account"
					onClick={openDialog}
					variant="danger"
				>
					Delete account
				</Button>
				{props.emailOutboundPausedAt ? (
					<Button
						type="button"
						disabled={pending}
						onClick={() =>
							props.onSubmitModerationAction('resume_email_outbound')
						}
						variant="secondary"
					>
						{props.parentMutating ? 'Working…' : 'Resume outbound email'}
					</Button>
				) : null}
			</div>
			{open && (
				<ModalDialog
					alert
					flush
					label="Delete account"
					width={640}
					testId="admin-delete-account-dialog"
					onClose={closeDialog}
				>
					<form
						css={deleteDialogFormCss}
						onSubmit={(event) => {
							event.preventDefault()
							if (!summary || !canDelete) return
							deletion.mutate({ typedHandle, acknowledged })
						}}
					>
						<h3 id="admin-delete-account-title" css={deleteDialogTitleCss}>
							Delete @{props.username}?
						</h3>
						<p css={{ margin: 0, color: colors.textMuted }}>
							This permanently deletes the account and frees the handle.
							Organizations this person does not solely own stay, including
							their other members.
						</p>
						{summaryQuery.isPending ? (
							<LoadingIndicator label="Loading account summary…" />
						) : null}
						{summaryQuery.isError ? (
							<p role="alert" css={{ margin: 0, color: colors.danger }}>
								{summaryQuery.error instanceof Error
									? summaryQuery.error.message
									: 'Unable to load the account summary.'}
							</p>
						) : null}
						{summary ? (
							<AdminAccountDeletionSummaryList summary={summary} />
						) : null}
						{summary?.acknowledgementRequired ? (
							<label css={acknowledgeCss}>
								<input
									type="checkbox"
									data-testid="admin-delete-account-acknowledge"
									checked={acknowledged}
									onChange={(event) => {
										setAcknowledged(event.currentTarget.checked)
									}}
								/>
								<span>I acknowledge the consequences listed above.</span>
							</label>
						) : null}
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>
								Type {summary?.handle ?? props.username} to confirm
							</span>
							<input
								type="text"
								name="handleConfirmation"
								data-testid="admin-delete-account-handle"
								data-field-ring
								autoComplete="off"
								spellCheck={false}
								required
								value={typedHandle}
								css={accountInputCss}
								onInput={(event: FormEvent<HTMLInputElement>) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									setTypedHandle(event.currentTarget.value)
								}}
							/>
						</label>
						<div css={getAccentCalloutCss({ accentColor: colors.danger })}>
							<p css={{ margin: 0 }}>
								This cannot be undone. The handle can be registered again after
								the account is deleted.
							</p>
						</div>
						{deletion.error ? (
							<p role="alert" css={{ margin: 0, color: colors.danger }}>
								{deletion.error instanceof Error
									? deletion.error.message
									: 'Unable to delete the account.'}
							</p>
						) : null}
						<div css={accountActionsCss}>
							<Button
								type="button"
								disabled={deletion.isPending}
								variant="secondary"
								onClick={closeDialog}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={!canDelete}
								data-testid="admin-delete-account-confirm"
								variant="danger"
							>
								{deletion.isPending ? 'Deleting…' : 'Delete account'}
							</Button>
						</div>
					</form>
				</ModalDialog>
			)}
		</>
	)
}

const acknowledgeCss: CSSObject = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	color: colors.text,
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

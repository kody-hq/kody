/** @jsxImportSource @emotion/react */
import { useMutation, useQuery } from '@tanstack/react-query'
import { type CSSObject } from '@emotion/react'
import { useRef, useState, type FormEvent } from 'react'
import {
	deleteAdminUserAccount,
	readAdminAccountDeletionSummary,
} from '#start/server/admin-account-deletion'
import { canConfirmAdminAccountDeletion } from '#universal/admin-account-deletion.ts'
import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountInputCss,
} from './account-management-components.tsx'
import { AdminAccountDeletionSummaryList } from './admin-account-deletion-summary.tsx'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

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
	const dialog = useRef<HTMLDialogElement>(null)
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
		dialog.current?.close()
	}

	function openDialog() {
		setTypedHandle('')
		setAcknowledged(false)
		deletion.reset()
		setOpen(true)
		dialog.current?.showModal()
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
					<button
						type="button"
						disabled={pending}
						onClick={() => props.onSubmitModerationAction('unsuspend_user')}
						css={primaryButtonCss}
					>
						{props.parentMutating ? 'Working…' : 'Clear suspension'}
					</button>
				) : (
					<button
						type="button"
						disabled={pending}
						data-testid="admin-suspend-account"
						onClick={() => props.onSubmitModerationAction('suspend_user')}
						css={secondaryButtonCss}
					>
						{props.parentMutating ? 'Working…' : 'Suspend account'}
					</button>
				)}
				<button
					type="button"
					disabled={pending}
					data-testid="admin-delete-account"
					onClick={openDialog}
					css={dangerButtonCss}
				>
					Delete account
				</button>
				{props.emailOutboundPausedAt ? (
					<button
						type="button"
						disabled={pending}
						onClick={() =>
							props.onSubmitModerationAction('resume_email_outbound')
						}
						css={secondaryButtonCss}
					>
						{props.parentMutating ? 'Working…' : 'Resume outbound email'}
					</button>
				) : null}
			</div>
			<dialog
				aria-labelledby="admin-delete-account-title"
				data-testid="admin-delete-account-dialog"
				ref={dialog}
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
						Organizations this person does not solely own stay, including their
						other members.
					</p>
					{summaryQuery.isPending ? (
						<p css={{ margin: 0, color: colors.textMuted }}>
							Loading account summary…
						</p>
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
						<button
							type="button"
							disabled={deletion.isPending}
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={closeDialog}
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!canDelete}
							data-testid="admin-delete-account-confirm"
							css={getDangerPillCss({ size: 'sm' })}
						>
							{deletion.isPending ? 'Deleting…' : 'Delete account'}
						</button>
					</div>
				</form>
			</dialog>
		</>
	)
}

const acknowledgeCss: CSSObject = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	color: colors.text,
}

const deleteDialogCss: CSSObject = {
	width: 'min(40rem, calc(100vw - 2rem))',
	maxWidth: '40rem',
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

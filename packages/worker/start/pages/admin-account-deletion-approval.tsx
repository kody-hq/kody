/** @jsxImportSource @emotion/react */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { approveAdminAccountDeletion } from '#start/server/admin-account-deletion'
import {
	canApproveAdminAccountDeletion,
	type AdminAccountDeletionApprovalState,
} from '#universal/admin-account-deletion.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { routes } from '#universal/routes.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	accountActionsCss,
} from './account-management-components.tsx'
import { AdminAccountDeletionSummaryList } from './admin-account-deletion-summary.tsx'

export function AdminAccountDeletionApprovalPage(props: {
	approvalId: string
	approval: AdminAccountDeletionApprovalState
	currentHref: string
}) {
	const [acknowledged, setAcknowledged] = useState(false)
	const approval = props.approval
	const mutation = useMutation({
		retry: false,
		mutationFn: async () => {
			const payload = await approveAdminAccountDeletion({
				data: {
					approvalId: props.approvalId,
					acknowledge: acknowledged,
				},
			})
			return payload.handle
		},
	})
	const summary = approval.status === 'pending' ? approval.summary : null
	const canApprove = summary
		? canApproveAdminAccountDeletion({
				acknowledgementRequired: summary.acknowledgementRequired,
				acknowledged,
				pending: mutation.isPending,
				deletionBlocked: summary.deletionBlocked,
			})
		: false

	return (
		<AccountManagementShell currentHref={props.currentHref}>
			<AdminPageHeader
				title="Delete account"
				description="Review this account, then approve the hard delete. Nothing is removed until you approve."
				currentHref={props.currentHref}
			/>
			<AccountManagementPanel title="Account">
				{approval.status === 'missing' ? (
					<AccountManagementMessage tone="error">
						This approval link is not valid.
					</AccountManagementMessage>
				) : null}
				{approval.status === 'expired' ? (
					<AccountManagementMessage tone="error">
						This approval link has expired. Request a new one.
					</AccountManagementMessage>
				) : null}
				{approval.status === 'consumed' ? (
					<AccountManagementMessage>
						This deletion was already approved.
					</AccountManagementMessage>
				) : null}
				{mutation.isSuccess ? (
					<AccountManagementMessage>
						Deleted @{mutation.data}. The handle can be registered again.
					</AccountManagementMessage>
				) : null}
				{summary && !mutation.isSuccess ? (
					<form
						css={{ display: 'grid', gap: spacing.md }}
						onSubmit={(event) => {
							event.preventDefault()
							if (!canApprove) return
							mutation.mutate()
						}}
					>
						<AdminAccountDeletionSummaryList summary={summary} />
						<p css={{ margin: 0, color: colors.textMuted }}>
							Deleting removes this person, their personal organization, and the
							handle. Organizations they do not solely own stay, including other
							members and their data.
						</p>
						{summary.acknowledgementRequired ? (
							<label
								css={{
									display: 'flex',
									gap: spacing.sm,
									alignItems: 'flex-start',
								}}
							>
								<input
									type="checkbox"
									data-testid="admin-account-deletion-acknowledge"
									checked={acknowledged}
									onChange={(event) => {
										setAcknowledged(event.currentTarget.checked)
									}}
								/>
								<span>I acknowledge the consequences listed above.</span>
							</label>
						) : null}
						{mutation.error ? (
							<AccountManagementMessage tone="error">
								{mutation.error instanceof Error
									? mutation.error.message
									: 'Unable to delete the account.'}
							</AccountManagementMessage>
						) : null}
						<div css={accountActionsCss}>
							<SiteLink
								href={routes.adminUsers.href()}
								css={getGhostButtonCss({ size: 'sm' })}
							>
								Cancel
							</SiteLink>
							<button
								type="submit"
								disabled={!canApprove}
								data-testid="admin-account-deletion-approve"
								css={getDangerPillCss({ size: 'sm' })}
							>
								{mutation.isPending ? 'Deleting…' : 'Approve'}
							</button>
						</div>
					</form>
				) : null}
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

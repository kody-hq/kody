/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { convertPersonalOrganization } from '#start/server/convert-personal-org'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { conversionMutationOptions } from '../convert-personal-org-mutation.ts'
import { useRouter } from '@tanstack/react-router'
import { toast } from '#client/toast.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'

export function AccountConvertPersonalOrgPanel({
	username,
}: {
	username: string
}) {
	const { actorKey } = useMatchedPageScope()
	const client = useQueryClient(),
		capture = useSubmitterScope()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [newHandle, setNewHandle] = useState('')
	const [confirmation, setConfirmation] = useState('')
	const [error, setError] = useState<string | null>(null)
	const router = useRouter()
	const mutation = useMutation(
		conversionMutationOptions(client, convertPersonalOrganization),
	)
	const current = username.trim(),
		expected = `convert @${current}`
	const ready =
		confirmOpen &&
		Boolean(current) &&
		confirmation.trim().toLowerCase() === expected.toLowerCase() &&
		Boolean(newHandle.trim()) &&
		!mutation.isPending
	return (
		<AccountManagementPanel
			title="Convert personal organization"
			description="Turn your signup organization into a general-purpose team organization that keeps its handle, packages, and plan. You pick a new personal handle; memories, credentials, integrations, and MCP servers move with you."
		>
			{!confirmOpen ? (
				<div>
					<button
						type="button"
						data-testid="account-convert-personal-org-start"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={() => {
							setConfirmOpen(true)
							setConfirmation('')
							setError(null)
						}}
					>
						Convert @{current || '…'}…
					</button>
				</div>
			) : (
				<form
					data-testid="account-convert-personal-org-form"
					css={{ display: 'grid', gap: spacing.md }}
					onSubmit={async (event) => {
						event.preventDefault()
						if (!ready) return
						const isCurrent = capture()
						setError(null)
						try {
							const result = await mutation.mutateAsync({
								data: { newHandle, confirmation },
								actorKey,
							})
							if (!isCurrent()) return
							if (!result.ok) {
								setError(result.error)
								return
							}
							setConfirmOpen(false)
							setConfirmation('')
							try {
								await router.invalidate({ sync: true })
							} catch {
								if (isCurrent())
									toast.error(
										'Conversion completed. Reload to refresh your account. Do not repeat the conversion.',
									)
								return
							}
							if (!isCurrent()) return
							toast.success(
								`@${result.convertedSlug} is now a team organization. Your personal account is @${result.newUsername}.`,
							)
							if (result.followUpFailures.length) {
								const labels = {
									oauth_grants: 'OAuth access cleanup',
									email_inbox: 'your default email inbox',
									memory_index: 'memory search indexing',
								}
								toast.error(
									`Conversion completed. Follow-up work is still needed for ${result.followUpFailures.map((failure) => labels[failure]).join(', ')}. Do not repeat the conversion.`,
								)
							}
						} catch (caught) {
							if (isCurrent())
								setError(
									caught instanceof Error
										? caught.message
										: 'Unable to convert your personal organization.',
								)
						}
					}}
				>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
							maxWidth: '60ch',
						}}
					>
						@{current} stays as a team organization you own. Packages, webhooks,
						email, and billing stay there. Your new personal organization starts
						from your current name and avatar.
					</p>
					<div css={accountFieldCss}>
						<label htmlFor="convert-new-handle" css={accountFieldLabelCss}>
							New personal handle
						</label>
						<input
							id="convert-new-handle"
							name="newHandle"
							data-testid="account-convert-personal-org-handle"
							data-field-ring
							autoComplete="off"
							spellCheck={false}
							value={newHandle}
							placeholder="new-handle"
							css={accountInputCss}
							disabled={mutation.isPending}
							onChange={(event) => setNewHandle(event.currentTarget.value)}
						/>
						<p css={accountFieldNoteCss}>
							This becomes your username and the handle of your new personal
							organization. Choose carefully, handles stay put after this.
						</p>
					</div>
					<div css={accountFieldCss}>
						<label htmlFor="convert-confirm" css={accountFieldLabelCss}>
							Type {expected} to confirm
						</label>
						<input
							id="convert-confirm"
							name="confirmation"
							data-testid="account-convert-personal-org-confirm"
							data-field-ring
							autoComplete="off"
							spellCheck={false}
							value={confirmation}
							css={accountInputCss}
							disabled={mutation.isPending}
							onChange={(event) => setConfirmation(event.currentTarget.value)}
						/>
					</div>
					{error ? (
						<p
							role="alert"
							data-testid="account-convert-personal-org-error"
							css={{
								margin: 0,
								color: colors.danger,
								fontSize: typography.fontSize.sm,
							}}
						>
							{error}
						</p>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="button"
							css={getGhostButtonCss({ size: 'sm' })}
							disabled={mutation.isPending}
							onClick={() => {
								setConfirmOpen(false)
								setConfirmation('')
								setError(null)
							}}
						>
							Cancel
						</button>
						<button
							type="submit"
							data-testid="account-convert-personal-org-submit"
							css={
								ready
									? getDangerPillCss({ size: 'sm' })
									: getPillButtonCss({ size: 'sm' })
							}
							disabled={!ready}
						>
							{mutation.isPending ? 'Converting…' : 'Convert organization'}
						</button>
					</div>
				</form>
			)}
		</AccountManagementPanel>
	)
}

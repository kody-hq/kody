/** @jsxImportSource @emotion/react */
import {
	fieldCss,
	fieldLabelCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { convertPersonalOrganization } from '#start/server/convert-personal-org'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { conversionMutationOptions } from '../convert-personal-org-mutation.ts'
import { useRouter } from '@tanstack/react-router'
import { toast } from '#client/toast.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
} from './account-management-components.tsx'
import { Input } from '../components/input.tsx'
import { getHandleFormatProblem } from '@kody-internal/shared/handle-rules.ts'
import {
	HandleSuggestion,
	useVerifiedHandleSuggestion,
} from '../components/handle-suggestion.tsx'

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
	const handleInputRef = useRef<HTMLInputElement>(null)
	const handleProblem = newHandle.trim()
		? getHandleFormatProblem(newHandle.trim())
		: null
	const handleSuggestion = useVerifiedHandleSuggestion(
		handleProblem?.suggestion ?? null,
	)
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
					<Button
						type="button"
						data-testid="account-convert-personal-org-start"
						variant="secondary"
						onClick={() => {
							setConfirmOpen(true)
							setConfirmation('')
							setError(null)
						}}
					>
						Convert @{current || '…'}…
					</Button>
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
									mcp_servers: 'reconnecting moved MCP servers',
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
					<div css={fieldCss}>
						<label htmlFor="convert-new-handle" css={fieldLabelCss}>
							New personal handle
						</label>
						<Input
							ref={handleInputRef}
							id="convert-new-handle"
							name="newHandle"
							data-testid="account-convert-personal-org-handle"
							autoComplete="off"
							spellCheck={false}
							value={newHandle}
							placeholder="new-handle"
							disabled={mutation.isPending}
							aria-invalid={handleProblem ? true : undefined}
							aria-describedby={
								handleProblem ? 'convert-new-handle-error' : undefined
							}
							onChange={(event) => setNewHandle(event.currentTarget.value)}
						/>
						{handleProblem ? (
							<p
								id="convert-new-handle-error"
								aria-live="polite"
								data-testid="account-convert-personal-org-handle-error"
								css={{
									margin: 0,
									color: colors.danger,
									fontSize: typography.fontSize.sm,
								}}
							>
								{handleProblem.message}
								<HandleSuggestion
									suggestion={handleSuggestion}
									disabled={mutation.isPending}
									onApply={(suggestion) => {
										handleInputRef.current?.focus()
										setNewHandle(suggestion)
									}}
								/>
							</p>
						) : null}
						<p css={fieldDescriptionCss}>
							This becomes your username and the handle of your new personal
							organization. Choose carefully, handles stay put after this.
						</p>
					</div>
					<div css={fieldCss}>
						<label htmlFor="convert-confirm" css={fieldLabelCss}>
							Type {expected} to confirm
						</label>
						<Input
							id="convert-confirm"
							name="confirmation"
							data-testid="account-convert-personal-org-confirm"
							autoComplete="off"
							spellCheck={false}
							value={confirmation}
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
						<Button
							type="button"
							variant="secondary"
							disabled={mutation.isPending}
							onClick={() => {
								setConfirmOpen(false)
								setConfirmation('')
								setError(null)
							}}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							data-testid="account-convert-personal-org-submit"
							variant={ready ? 'danger' : 'primary'}
							disabled={!ready}
						>
							{mutation.isPending ? 'Converting…' : 'Convert organization'}
						</Button>
					</div>
				</form>
			)}
		</AccountManagementPanel>
	)
}

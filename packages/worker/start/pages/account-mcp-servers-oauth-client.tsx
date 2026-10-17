/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { accountInputCss } from './account-management-components.tsx'
import { type McpServerListItem } from './account-mcp-servers-shared.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	type getDangerPillCss,
	type getGhostButtonCss,
	type getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

export type McpServerOAuthClientInput = {
	clientId: string
	clientSecret: string
}
export function McpServerOAuthClientSection({
	server,
	isMutating,
	primaryButtonCss,
	secondaryButtonCss,
	dangerButtonCss,
	onSave,
	onRemove,
}: {
	server: McpServerListItem
	isMutating: boolean
	primaryButtonCss: ReturnType<typeof getPillButtonCss>
	secondaryButtonCss: ReturnType<typeof getGhostButtonCss>
	dangerButtonCss: ReturnType<typeof getDangerPillCss>
	onSave: (client: McpServerOAuthClientInput) => Promise<boolean>
	onRemove: () => void
}) {
	const [editing, setEditing] = useState(false)
	const [clientId, setClientId] = useState('')
	const [clientSecret, setClientSecret] = useState('')
	const [removeArmed, setRemoveArmed] = useState(false)
	const configured = server.oauthClientId != null
	const headingId = `mcp-oauth-client-heading-${server.id}`
	const secretId = `mcp-oauth-client-secret-${server.id}`
	function reset() {
		setEditing(false)
		setClientId('')
		setClientSecret('')
		setRemoveArmed(false)
	}
	return (
		<section
			data-testid="mcp-server-oauth-client"
			aria-labelledby={headingId}
			css={{
				display: 'grid',
				gap: spacing.sm,
				padding: spacing.md,
				borderRadius: radius.md,
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.background,
			}}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h3 id={headingId} css={{ ...fieldLabelCss, margin: 0 }}>
					OAuth client <span css={{ color: colors.textMuted }}>(optional)</span>
				</h3>
				<p css={{ ...descriptionCss, margin: 0 }}>
					Kody registers itself with most authorization servers on its own. Add
					a client ID and secret only when the server supports neither Client ID
					Metadata Documents nor dynamic client registration (for example
					GitHub), or when you must use a client you registered. Set its
					redirect URI to the OAuth redirect URI shown above.
				</p>
			</div>
			{configured ? (
				<div
					data-testid="mcp-server-oauth-client-configured"
					css={{ display: 'grid', gap: spacing.xs }}
				>
					<p
						css={{
							margin: 0,
							color: colors.text,
							fontSize: typography.fontSize.sm,
						}}
					>
						<strong>Configured.</strong> Client ID{' '}
						<code css={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
							{server.oauthClientId}
						</code>
						. The secret is stored sealed and is not shown again.
					</p>
					{!editing ? (
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="button"
								disabled={isMutating}
								css={secondaryButtonCss}
								onClick={() => {
									setEditing(true)
									setClientId(server.oauthClientId ?? '')
									setClientSecret('')
									setRemoveArmed(false)
								}}
							>
								Replace
							</button>
							<button
								type="button"
								disabled={isMutating}
								css={dangerButtonCss}
								onBlur={() => setRemoveArmed(false)}
								onClick={() => {
									if (removeArmed) {
										reset()
										onRemove()
									} else setRemoveArmed(true)
								}}
							>
								{removeArmed ? 'Confirm remove OAuth client' : 'Remove'}
							</button>
						</div>
					) : null}
				</div>
			) : null}
			{!configured || editing ? (
				<form
					method="post"
					noValidate
					data-testid="mcp-server-oauth-client-form"
					css={{ display: 'grid', gap: spacing.sm }}
					onSubmit={async (event) => {
						event.preventDefault()
						const saved = await onSave({
							clientId: clientId.trim(),
							clientSecret: clientSecret.trim(),
						})
						if (saved) reset()
					}}
				>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Client ID</span>
						<input
							data-field-ring
							name="clientId"
							value={clientId}
							disabled={isMutating}
							required
							autoComplete="off"
							spellCheck={false}
							css={accountInputCss}
							onChange={(event) => setClientId(event.currentTarget.value)}
						/>
					</label>
					<div css={fieldCss}>
						<label htmlFor={secretId} css={fieldLabelCss}>
							Client secret
						</label>
						<PasswordRevealInput
							data-field-ring
							id={secretId}
							name="clientSecret"
							value={clientSecret}
							disabled={isMutating}
							required
							autoComplete="off"
							data-1p-ignore
							data-lpignore="true"
							revealNoun="client secret"
							css={accountInputCss}
							onChange={(event) => setClientSecret(event.currentTarget.value)}
						/>
					</div>
					<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
						<button
							type="submit"
							disabled={isMutating || !clientId.trim() || !clientSecret.trim()}
							css={primaryButtonCss}
						>
							{isMutating
								? 'Saving…'
								: configured
									? 'Replace OAuth client'
									: 'Save OAuth client'}
						</button>
						{editing ? (
							<button
								type="button"
								disabled={isMutating}
								css={secondaryButtonCss}
								onClick={reset}
							>
								Cancel
							</button>
						) : null}
					</div>
				</form>
			) : null}
		</section>
	)
}

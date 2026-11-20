/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { useState } from 'react'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import {
	type McpServerListItem,
	mcpCodeCss,
	mcpDetailSectionCss,
} from './account-mcp-servers-shared.tsx'
import { accountActionsCss } from './account-management-components.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import { Input } from '../components/input.tsx'

export type McpServerOAuthClientInput = {
	clientId: string
	clientSecret: string
}
export function McpServerOAuthClientSection({
	server,
	isMutating,
	onSave,
	onRemove,
}: {
	server: McpServerListItem
	isMutating: boolean
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
			css={mcpDetailSectionCss}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h3 id={headingId} css={sectionTitleCss}>
					OAuth client{' '}
					<span css={{ color: colors.textMuted, fontWeight: 400 }}>
						(optional)
					</span>
				</h3>
				<p css={{ ...descriptionCss, fontSize: typography.fontSize.sm }}>
					Kody registers itself with most servers. Add a client only when the
					server supports neither Client ID Metadata Documents nor dynamic
					client registration (for example GitHub), or when you must use your
					own. Set its redirect URI to the OAuth redirect URI above.
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
						<code css={mcpCodeCss}>{server.oauthClientId}</code>. The secret is
						stored sealed and is not shown again.
					</p>
					{!editing ? (
						<div css={accountActionsCss}>
							<Button
								type="button"
								mobileFullWidth
								disabled={isMutating}
								variant="secondary"
								onClick={() => {
									setEditing(true)
									setClientId(server.oauthClientId ?? '')
									setClientSecret('')
									setRemoveArmed(false)
								}}
							>
								Replace
							</Button>
							<Button
								type="button"
								mobileFullWidth
								disabled={isMutating}
								variant="danger"
								onBlur={() => setRemoveArmed(false)}
								onClick={() => {
									if (removeArmed) {
										reset()
										onRemove()
									} else setRemoveArmed(true)
								}}
							>
								{removeArmed ? 'Confirm remove OAuth client' : 'Remove'}
							</Button>
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
					<Field label="Client ID">
						<Input
							name="clientId"
							value={clientId}
							disabled={isMutating}
							required
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => setClientId(event.currentTarget.value)}
						/>
					</Field>
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
							onChange={(event) => setClientSecret(event.currentTarget.value)}
						/>
					</div>
					<div css={accountActionsCss}>
						<Button
							type="submit"
							mobileFullWidth
							disabled={isMutating || !clientId.trim() || !clientSecret.trim()}
							variant="primary"
						>
							{isMutating
								? 'Saving…'
								: configured
									? 'Replace OAuth client'
									: 'Save OAuth client'}
						</Button>
						{editing ? (
							<Button
								type="button"
								mobileFullWidth
								disabled={isMutating}
								variant="secondary"
								onClick={reset}
							>
								Cancel
							</Button>
						) : null}
					</div>
				</form>
			) : null}
		</section>
	)
}

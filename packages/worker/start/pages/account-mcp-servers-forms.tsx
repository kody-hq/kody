/** @jsxImportSource @emotion/react */
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { accountInputCss } from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	type getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

export type OauthCallbackSectionProps = {
	oauthClientOrigin: string
	oauthCallbackUrl: string
	oauthClientMetadataUrl: string | null
}

export function renderOauthCallbackSection(props: OauthCallbackSectionProps) {
	const { oauthClientOrigin, oauthCallbackUrl, oauthClientMetadataUrl } = props
	return (
		<section
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
				<span css={fieldLabelCss}>OAuth redirect URI</span>
				<p css={{ ...descriptionCss, margin: 0 }}>
					If a remote MCP server&apos;s identity provider allowlists client
					origins or redirect URIs (for example FusionAuth), add
					{oauthClientOrigin ? ` ${oauthClientOrigin} and` : ''} this exact
					callback before authorizing.
					{oauthClientMetadataUrl
						? " Servers that support Client ID Metadata Documents use the CIMD URL as Kody's client_id."
						: ''}
				</p>
			</div>
			<code
				css={{
					padding: spacing.sm,
					borderRadius: radius.md,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.background,
					color: colors.text,
					fontFamily: 'monospace',
					fontSize: typography.fontSize.sm,
					overflowWrap: 'anywhere',
				}}
			>
				{oauthCallbackUrl}
			</code>
			<div>
				<CopyTextButton
					value={oauthCallbackUrl}
					idleLabel="Copy redirect URI"
					variant="secondary"
					size="sm"
				/>
			</div>
			{oauthClientMetadataUrl ? (
				<>
					<span css={fieldLabelCss}>OAuth client metadata URL</span>
					<code
						css={{
							padding: spacing.sm,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.background,
							color: colors.text,
							fontFamily: 'monospace',
							fontSize: typography.fontSize.sm,
							overflowWrap: 'anywhere',
						}}
					>
						{oauthClientMetadataUrl}
					</code>
					<div>
						<CopyTextButton
							value={oauthClientMetadataUrl}
							idleLabel="Copy CIMD URL"
							variant="secondary"
							size="sm"
						/>
					</div>
				</>
			) : null}
		</section>
	)
}

export type AddMcpServerFormProps = {
	addName: string
	addUrl: string
	addBearerToken: string
	isMutating: boolean
	isBusy: boolean
	primaryButtonCss: ReturnType<typeof getPillButtonCss>
	onSubmit: (form: HTMLFormElement) => void
	onNameInput: (value: string) => void
	onUrlInput: (value: string) => void
	onBearerTokenInput: (value: string) => void
}

export function renderAddMcpServerForm(props: AddMcpServerFormProps) {
	const {
		addName,
		addUrl,
		addBearerToken,
		isMutating,
		isBusy,
		primaryButtonCss,
		onSubmit,
		onNameInput,
		onUrlInput,
		onBearerTokenInput,
	} = props
	return (
		<form
			method="post"
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				if (event.currentTarget instanceof HTMLFormElement) {
					onSubmit(event.currentTarget)
				}
			}}
			css={recordBodyCss}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>Add MCP server</h2>
				<p css={descriptionCss}>
					Provide a short name and the server URL. Remote servers must use
					https; Kody connects as an MCP client and discovers the server&apos;s
					tools. For servers that use a static bearer token instead of OAuth,
					paste it below.
				</p>
			</div>

			<label css={fieldCss}>
				<span css={fieldLabelCss}>Server name</span>
				<input
					data-field-ring
					name="name"
					type="text"
					value={addName}
					placeholder="linear"
					disabled={isMutating}
					required
					autoComplete="off"
					onInput={(event) => {
						onNameInput(event.currentTarget.value)
					}}
					css={accountInputCss}
				/>
				<span css={descriptionCss}>
					Lowercase letters, numbers, and dashes. Used as the
					kody.mcp[&quot;name&quot;] namespace.
				</span>
			</label>

			<label css={fieldCss}>
				<span css={fieldLabelCss}>Server URL</span>
				<input
					data-field-ring
					name="url"
					type="url"
					value={addUrl}
					placeholder="https://mcp.example.com/mcp"
					disabled={isMutating}
					required
					autoComplete="off"
					onInput={(event) => {
						onUrlInput(event.currentTarget.value)
					}}
					css={accountInputCss}
				/>
				<span css={descriptionCss}>
					Use the MCP endpoint path, not the vendor&apos;s marketing site.
					PostHog is https://mcp.posthog.com/mcp.
				</span>
			</label>

			<label css={fieldCss}>
				<span css={fieldLabelCss}>
					Bearer token <span css={{ color: colors.textMuted }}>(optional)</span>
				</span>
				<input
					data-field-ring
					name="bearerToken"
					type="password"
					value={addBearerToken}
					placeholder="Paste token (or Bearer …)"
					disabled={isMutating}
					autoComplete="off"
					onInput={(event) => {
						onBearerTokenInput(event.currentTarget.value)
					}}
					css={accountInputCss}
				/>
				<span css={descriptionCss}>
					Sent as Authorization: Bearer &lt;token&gt; on every request. You can
					paste a bare token, a scheme-prefixed value (Bearer, token, etc.), or
					a full Authorization header line. Leave blank for OAuth or
					unauthenticated servers. The token is stored only in your private MCP
					client hub and is never shown again.
				</span>
			</label>

			<div>
				<button type="submit" disabled={isMutating} css={primaryButtonCss}>
					{isBusy ? 'Adding...' : 'Add server'}
				</button>
			</div>
		</form>
	)
}

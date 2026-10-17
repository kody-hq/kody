/** @jsxImportSource @emotion/react */
import { continueMcpAuthorization } from '#start/server/account-mutations'
import { type McpServerAuthorizeLoaderData } from '#universal/loader-data.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { type McpOAuthClientMode } from '@kody-internal/shared/mcp-servers.ts'
import { useMutation } from '@tanstack/react-query'
import { type FormEvent } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import {
	accountActionsCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
function clientModeCopy(mode: McpOAuthClientMode) {
	switch (mode) {
		case 'cimd':
			return {
				label: 'Client ID Metadata Document (CIMD)',
				detail:
					'Kody identifies itself with its published client metadata document.',
			}
		case 'dcr':
			return {
				label: 'Dynamic Client Registration (DCR)',
				detail: 'Kody registered itself with this authorization server.',
			}
		case 'pre-registered':
			return {
				label: 'Pre-registered OAuth client',
				detail:
					"Kody uses the OAuth client an admin saved in this server's settings.",
			}
		default: {
			const exhaustive: never = mode
			throw new Error(`Unhandled MCP OAuth client mode: ${String(exhaustive)}`)
		}
	}
}
const codeCss = {
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
} as const
/**
 * Leave Kody for the provider without a Referer. Providers that allowlist
 * origins on Referer reject Kody's.
 */
function navigateWithoutReferrer(url: string) {
	const link = document.createElement('a')
	link.href = url
	link.rel = 'noreferrer'
	link.hidden = true
	document.body.append(link)
	link.click()
	link.remove()
}
const noteCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} as const
export function AccountMcpServerAuthorizePage({
	payload,
	currentHref: href,
}: {
	payload: McpServerAuthorizeLoaderData
	currentHref: string
}) {
	const mutation = useMutation({
		mutationKey: ['mcpServerConsent', href],
		mutationFn: (
			data: Parameters<typeof continueMcpAuthorization>[0]['data'],
		) => continueMcpAuthorization({ data }),
		onSuccess: (result) => {
			if (result.ok) navigateWithoutReferrer(result.authorizationUrl)
		},
	})
	const result = mutation.data
	const data =
		result && !result.ok
			? (result.consent ?? { ...payload, error: result.error })
			: mutation.error
				? {
						...payload,
						error: 'Unable to continue. Reload the page and try again.',
					}
				: payload
	const submitting = mutation.isPending
	function submitContinue(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting || !data.pending) return
		mutation.mutate({
			orgSlug: data.orgSlug,
			serverId: data.serverId,
			token: data.pending.csrfToken,
		})
	}
	const { pending } = data
	const mode = pending ? clientModeCopy(pending.clientMode) : null
	return (
		<AccountManagementShell currentHref={href} maxWidth="40rem">
			<AccountPageHeader
				entity="mcp-servers"
				title={`Authorize ${data.serverName}`}
				description="Review where Kody is sending you before you approve access. Nothing is approved until you click Continue."
				currentHref={href}
			/>
			{data.error ? (
				<AccountManagementMessage tone="error">
					{data.error}
				</AccountManagementMessage>
			) : null}
			{pending && mode ? (
				<AccountManagementPanel
					title="Review this connection"
					description={`Continue opens ${pending.authorizationServerHost}. After you approve there, you come back to Kody and this server's tools become available to this organization.`}
				>
					<MetadataGrid
						items={[
							{
								label: 'MCP server',
								value: (
									<span data-testid="mcp-authorize-server-name">
										{data.serverName}
									</span>
								),
							},
							{
								label: 'Server URL',
								value: <code css={codeCss}>{data.serverUrl}</code>,
							},
							{
								label: 'Authorization server',
								value: (
									<code data-testid="mcp-authorize-host" css={codeCss}>
										{pending.authorizationServerHost}
									</code>
								),
							},
							{
								label: 'Client mode',
								value: (
									<span data-testid="mcp-authorize-client-mode">
										{mode.label}
									</span>
								),
							},
						]}
					/>
					<p css={noteCss}>{mode.detail}</p>
					<form css={accountActionsCss} onSubmit={submitContinue}>
						<button
							type="submit"
							disabled={submitting}
							data-testid="mcp-authorize-continue"
							css={getPillButtonCss({ size: 'sm' })}
						>
							{submitting
								? `Opening ${pending.authorizationServerHost}…`
								: `Continue to ${pending.authorizationServerHost}`}
						</button>
						<SiteLink
							href={data.serverHref}
							css={{
								...getGhostButtonCss({ size: 'sm' }),
								textDecoration: 'none',
							}}
						>
							Cancel
						</SiteLink>
					</form>
				</AccountManagementPanel>
			) : (
				<AccountManagementPanel title="Nothing to approve">
					<p css={{ margin: 0, color: colors.text }}>
						{data.serverName} is not waiting for approval. Open the server and
						click Reconnect to start a new authorization.
					</p>
					<div css={accountActionsCss}>
						<SiteLink
							href={data.serverHref}
							css={{
								...getPillButtonCss({ size: 'sm' }),
								textDecoration: 'none',
							}}
						>
							Open {data.serverName}
						</SiteLink>
					</div>
				</AccountManagementPanel>
			)}
		</AccountManagementShell>
	)
}

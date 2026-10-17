/** @jsxImportSource @emotion/react */
import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { connectionUsageQuery } from '../connection-usage-query.ts'
import { ConnectionProfiles } from './connection-profiles-panel.tsx'
import {
	ConnectionUsageSummaryPanel,
	ConnectionUsageDetails,
	type ConnectionUsageState,
} from './account-connection-usage-panel.tsx'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { useAccountConnectedAgents } from './account-connected-agents-panel.tsx'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from './account-management-components.tsx'
import { CopyCard } from './onboarding-mcp-client-cards.tsx'
import {
	AgentPickerGrid,
	AgentSurfaceInstructions,
} from './onboarding-mcp-client-tabs.tsx'
import {
	type AccountConnectionsView,
	accountConnectionAgentIds,
	accountConnectionsNewHref,
	accountConnectionsListHref,
} from '#universal/account-connections.ts'
import { docHref } from '#universal/docs-nav.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { onboardingSecondAgentGreyedPresentation } from '#universal/onboarding-agent-ecosystems.ts'
import {
	type McpClientKind,
	onboardingAgentLabel,
} from '#universal/onboarding-mcp-clients.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const connectYourAgentDocHref = docHref('connect-your-agent')

/**
 * `/@slug/-/agents` — the durable home for inbound MCP hosts. The
 * connected list is the same panel Overview used to host. Connect an agent
 * is its own page (`/new`): the full client wall from onboarding Step 1
 * with no phone/desktop split and nothing folded under Not listed, not a
 * nested child of the list. `/new/:agent` shows that host's install
 * steps. Sign-in providers stay on Overview; outbound MCP servers stay on
 * MCP servers.
 */
export function AccountConnectionsPage({
	orgSlug,
	view,
	payload,
	currentHref,
}: {
	payload: AccountConnectedAgentsLoaderData
	view: AccountConnectionsView | null
	orgSlug: string
	currentHref: string
}) {
	const connectedAgents = useAccountConnectedAgents(payload)
	const { actorKey } = useRouteContext({ from: '__root__' })
	const usage = useQuery({
		...connectionUsageQuery(actorKey, orgSlug),
		enabled: view?.kind === 'list' || view?.kind === 'usage',
	})
	const usageState: ConnectionUsageState = usage.data
		? { kind: 'ready', usage: usage.data }
		: usage.isError
			? { kind: 'error', message: usage.error.message }
			: { kind: 'loading' }
	return (
		<AccountManagementShell currentHref={currentHref}>
			<AccountPageHeader
				entity="connections"
				title="Agents"
				description="The agents connected to this Kody account, and how to connect another."
				currentHref={currentHref}
			/>
			{renderReadyView({
				view,
				currentHref,
				payload,
				usageState,
				connectedAgents,
				mcpServerUrl: payload.mcpServerUrl,
			})}
		</AccountManagementShell>
	)
}

function renderBackToConnections(currentHref: string) {
	return (
		<SiteLink
			href={accountConnectionsListHref(currentHref)}
			data-testid="account-connections-back"
			css={backLinkCss}
		>
			← back to agents
		</SiteLink>
	)
}

function renderReadyView(input: {
	currentHref: string
	payload: AccountConnectedAgentsLoaderData
	usageState: ConnectionUsageState
	view: AccountConnectionsView | null
	connectedAgents: ReturnType<typeof useAccountConnectedAgents>
	mcpServerUrl: string
}) {
	if (input.view === null) {
		return (
			<>
				{renderBackToConnections(input.currentHref)}
				{renderUnknownAgent(input.currentHref)}
			</>
		)
	}
	switch (input.view.kind) {
		case 'list':
			return (
				<>
					{input.connectedAgents.render({
						actions: (
							<SiteLink
								href={accountConnectionsNewHref(null, input.currentHref)}
								data-testid="account-connections-add"
								css={primaryButtonCss}
							>
								Connect an agent
							</SiteLink>
						),
					})}
					<ConnectionUsageSummaryPanel
						state={input.usageState}
						agents={input.connectedAgents.listAgents()}
						pathname={input.currentHref}
					/>
					<ConnectionProfiles
						payload={input.payload}
						agents={input.connectedAgents.listAgents()}
						currentHref={input.currentHref}
					/>
					{renderMcpUrlPanel({ mcpServerUrl: input.mcpServerUrl })}
					{renderAdvancedPanel()}
				</>
			)
		case 'usage':
			return (
				<ConnectionUsageDetails
					state={input.usageState}
					agents={input.connectedAgents.listAgents()}
					pathname={input.currentHref}
					focus={new URL(
						input.currentHref,
						'https://kody.local',
					).searchParams.get('connection')}
				/>
			)
		case 'new':
			return (
				<>
					{renderBackToConnections(input.currentHref)}
					{input.view.agent === null
						? renderAgentGrid({
								mcpServerUrl: input.mcpServerUrl,
								currentHref: input.currentHref,
								connectedAgents: input.connectedAgents.listAgents(),
							})
						: renderAgentInstructions({
								agent: input.view.agent,
								mcpServerUrl: input.mcpServerUrl,
								currentHref: input.currentHref,
							})}
				</>
			)
		default: {
			const _exhaustive: never = input.view
			return _exhaustive
		}
	}
}

function renderAdvancedPanel() {
	return (
		<AccountManagementPanel
			title="Advanced"
			description="Optional tools for hosts that cannot finish dynamic OAuth on their own. This is not the list of agents already connected to your account."
		>
			<div css={accountActionsCss}>
				<SiteLink
					href={routes.accountMcpOauthClients.href()}
					css={compactGhostButtonCss}
				>
					MCP OAuth clients
				</SiteLink>
			</div>
		</AccountManagementPanel>
	)
}

function renderVerifyNote() {
	return (
		<p
			data-testid="account-connections-verify-note"
			css={{ color: colors.textMuted, margin: 0 }}
		>
			Verify your email to get this deployment&apos;s MCP URL. MCP access stays
			locked until the account email is verified.{' '}
			<SiteLink href={routes.pendingVerification.href()}>
				Verification page
			</SiteLink>
		</p>
	)
}

function renderMcpUrlPanel(input: { mcpServerUrl: string }) {
	return (
		<AccountManagementPanel
			title="MCP URL"
			description="Every host reaches the same account through one MCP URL. Connect an agent walks through a specific one; any other agent that speaks MCP can paste this URL and approve the Kody OAuth window."
			ariaLabel="MCP URL"
		>
			{input.mcpServerUrl ? (
				<CopyCard
					label="MCP URL"
					value={input.mcpServerUrl}
					copyLabel="Copy MCP URL"
					variant="pill"
				/>
			) : (
				renderVerifyNote()
			)}
			<div css={accountActionsCss}>
				<SiteLink href={connectYourAgentDocHref} css={compactGhostButtonCss}>
					Connect your agent docs
				</SiteLink>
			</div>
		</AccountManagementPanel>
	)
}

function renderAgentGrid(input: {
	currentHref: string
	mcpServerUrl: string
	connectedAgents: AccountConnectedAgentsLoaderData['agents']
}) {
	const connectedMark = onboardingSecondAgentGreyedPresentation(
		input.connectedAgents,
	)
	return (
		<AccountManagementPanel
			title="Connect an agent"
			description="Pick the agent you want to connect — including ones already connected, when you need the steps again for a second login, new machine, or reinstall. Every agent Kody knows how to connect is listed here, on every device; the next step shows that host's install path."
			ariaLabel="Connect an agent"
		>
			{input.mcpServerUrl ? (
				<div
					data-testid="account-connections-agent-grid"
					css={{ display: 'grid', gap: spacing.lg }}
				>
					<span className="visually-hidden" id="account-connections-add-title">
						Agents you can connect
					</span>
					<AgentPickerGrid
						ids={accountConnectionAgentIds.map((id) => ({
							id,
							viewport: 'both' as const,
						}))}
						labelledBy="account-connections-add-title"
						agentHref={(agent) =>
							accountConnectionsNewHref(agent, input.currentHref)
						}
						greyedAgents={connectedMark.greyedAgents}
						greyedReasons={connectedMark.greyedReasons}
						greyedTitles={connectedMark.greyedTitles}
					/>
					<div css={{ display: 'grid', gap: spacing.sm }}>
						<p css={{ color: colors.textMuted, margin: 0 }}>
							Using something else? Any agent that speaks MCP connects with this
							URL. Approve the Kody OAuth window when the host opens it.
						</p>
						<CopyCard
							label="MCP URL"
							value={input.mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
					</div>
				</div>
			) : (
				renderVerifyNote()
			)}
		</AccountManagementPanel>
	)
}

function renderAgentInstructions(input: {
	currentHref: string
	agent: McpClientKind
	mcpServerUrl: string
}) {
	const label = onboardingAgentLabel(input.agent)
	return (
		<AccountManagementPanel
			title={`Connect ${label}`}
			description="Follow the steps for this host, then approve the Kody OAuth window when it opens. The new connection appears on the Agents list once the host authorizes."
			ariaLabel={`Connect ${label}`}
		>
			<div css={accountActionsCss}>
				<SiteLink
					href={accountConnectionsNewHref(null, input.currentHref)}
					data-testid="account-connections-change-agent"
					css={compactGhostButtonCss}
				>
					Change agent
				</SiteLink>
			</div>
			{input.mcpServerUrl ? (
				<div
					data-testid="account-connections-agent-instructions"
					data-agent={input.agent}
					css={{ display: 'grid', gap: spacing.lg }}
				>
					<AgentSurfaceInstructions
						agent={input.agent}
						mcpServerUrl={input.mcpServerUrl}
					/>
				</div>
			) : (
				renderVerifyNote()
			)}
		</AccountManagementPanel>
	)
}

function renderUnknownAgent(currentHref: string) {
	return (
		<AccountManagementPanel
			title="Unknown agent"
			description="That agent is not one Kody knows how to connect. Pick one from the list, or use the MCP URL with any host that speaks MCP."
		>
			<div css={accountActionsCss}>
				<SiteLink
					href={accountConnectionsNewHref(null, currentHref)}
					css={compactGhostButtonCss}
				>
					Choose an agent
				</SiteLink>
			</div>
		</AccountManagementPanel>
	)
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const primaryButtonCss: CSSObject = {
	...getPillButtonCss({ size: 'sm' }),
	textDecoration: 'none',
	width: 'fit-content',
}

const backLinkCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	width: 'fit-content',
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

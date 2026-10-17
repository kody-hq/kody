/** @jsxImportSource @emotion/react */
import { landingArtAttrs, publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties, type RefCallback } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { routes } from '#universal/routes.ts'
import {
	onboardingAccessLede,
	onboardingAccessSelectedLede,
	onboardingAccessWinMadeLine,
	onboardingAgentHref,
	onboardingCopyPortabilityProofLabel,
	onboardingExplorePackagesHref,
	onboardingPortabilityProofPrompt,
	onboardingConnectedAgentLabelsLine,
	onboardingConnectedListSeparator,
	onboardingSecondAgentConnectedStatusLabel,
	portabilityGuideHref,
	onboardingSearchStartedLabel,
	onboardingSearchWaitingLabel,
	onboardingSecondAgentHref,
	onboardingSecondAgentLede,
	onboardingUnconnectedNotice,
	uniqueOnboardingConnectedAgents,
	type OnboardingConnectedAgentListItem,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import {
	onboardingSecondAgentGreyedPresentation,
	onboardingStep3EcosystemGroups,
} from '#universal/onboarding-agent-ecosystems.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	AgentPickerMark,
	OnboardingMcpClientTabs,
} from './onboarding-mcp-client-tabs.tsx'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	canonicalOnboardingAgentChooser,
} from '#client/routes/onboarding-mcp-clients.ts'
import { CopyCard } from './onboarding-mcp-client-cards.tsx'
import { OnboardingStep2Prompt } from './onboarding-step-2-prompt.tsx'
import { renderPlatformIntegrationCatalog } from './platform-integration-catalog.tsx'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'
import {
	WizardNavigation,
	connectStatusContent,
	connectStatusCss,
} from './onboarding-wizard-chrome.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

type StepNavigationProps = {
	activeStep: OnboardingWizardStepNumber
	onSelectStep: (step: OnboardingWizardStepNumber) => void
	search?: string
}

export function renderConnectAgentPanel(
	props: StepNavigationProps & {
		entrance: RefCallback<HTMLElement>
		loggedIn: boolean
		hasMcpClient: boolean
		connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
		selectedAgent: McpClientKind | null
		selectedAgentLabel: string | null
		agentChooser: OnboardingAgentChooserPick | null
		mcpServerUrl: string
		mcpHighlights: Record<string, HighlightedCode>
		awaitingConnect?: boolean
	},
) {
	return (
		<section
			id="onboarding-step-1"
			aria-labelledby="connect-title"
			data-testid="onboarding-connect-agent"
			css={wizardPanelCss}
			ref={props.entrance}
		>
			{renderAgentPanelHead({
				kicker: 'Step 1',
				titleId: 'connect-title',
				title: props.selectedAgentLabel
					? `Connect ${props.selectedAgentLabel}`
					: 'Connect your agent',
				selectedAgent: props.selectedAgent,
				changeHref: onboardingAgentHref(null, props.search ?? ''),
				artSrc: '/images/kody-mcp-plug.webp',
				artAlt: 'Kody plugging a cable into a warmly glowing port on a laptop',
				tilt: '2deg',
			})}
			{renderConnectAgentStatus(props)}
			{renderConnectedAgentsLine(
				connectedAgentsOnCard(props.selectedAgent, props.connectedAgents),
			)}
			<OnboardingMcpClientTabs
				mcpServerUrl={props.mcpServerUrl}
				highlights={props.mcpHighlights}
				selectedAgent={props.selectedAgent}
				chooser={props.agentChooser ?? canonicalOnboardingAgentChooser()}
				search={props.search ?? ''}
			/>
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				confirmUnconnectedNext={!props.hasMcpClient}
				connectWaitLabel={connectWaitLabel(props)}
			/>
		</section>
	)
}

export function renderAccessPanel(
	props: StepNavigationProps & {
		entrance: RefCallback<HTMLElement>
		hasMcpClient: boolean
		hasAccessWin: boolean
		discoveryPrompt: string
		featuredPlatformIntegrations?: ReadonlyArray<PlatformIntegrationCatalogItem>
		selectedAgentLabel: string | null
		connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
	},
) {
	const accessLede = props.hasMcpClient
		? onboardingAccessSelectedLede(props.selectedAgentLabel)
		: onboardingAccessLede
	return (
		<section
			id="onboarding-step-2"
			aria-labelledby="connect-mcp-title"
			data-testid="onboarding-connect-mcp"
			css={wizardPanelCss}
			ref={props.entrance}
		>
			<div css={panelHeadCss}>
				<div>
					<p css={panelKickerCss}>Step 2</p>
					<h2 id="connect-mcp-title" tabIndex={-1} css={panelTitleCss}>
						Make something useful
					</h2>
				</div>
				<img
					data-panel-art
					{...landingArtAttrs('kody-community-packages')}
					width={627}
					height={627}
					alt="Kody kneeling beside a stack of parcels, one open and glowing with a eucalyptus sprig"
					style={{ '--tilt': '1.5deg' } as CSSProperties}
					css={panelArtCss}
				/>
			</div>
			{props.hasMcpClient ? (
				<div
					css={connectStatusCss}
					role="status"
					aria-live="polite"
					data-testid="onboarding-search-status"
					data-connected={props.hasAccessWin ? 'true' : undefined}
				>
					{connectStatusContent({
						connected: props.hasAccessWin,
						connectedLabel: onboardingSearchStartedLabel,
						waitingLabel: onboardingSearchWaitingLabel,
					})}
				</div>
			) : null}
			{renderConnectedAgentsLine(props.connectedAgents)}
			<p css={panelLedeCss} data-testid="onboarding-access-lede">
				{accessLede}
			</p>
			{props.hasMcpClient ? (
				<OnboardingStep2Prompt />
			) : (
				<div data-testid="onboarding-unconnected-prompt" css={promptBlockCss}>
					<p css={unconnectedNoticeCss}>{onboardingUnconnectedNotice}</p>
					{props.discoveryPrompt ? (
						<CopyCard
							label="Discovery prompt"
							value={props.discoveryPrompt}
							copyLabel="Copy the discovery prompt"
						/>
					) : null}
				</div>
			)}
			{props.featuredPlatformIntegrations &&
			props.featuredPlatformIntegrations.length > 0 ? (
				<div
					data-testid="onboarding-platform-integrations"
					css={promptBlockCss}
				>
					<p css={panelLedeCss}>
						Or connect a service with Kody's built-in app:
					</p>
					{renderPlatformIntegrationCatalog({
						items: props.featuredPlatformIntegrations,
						testId: 'onboarding-platform-integration-list',
					})}
				</div>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
			/>
		</section>
	)
}

export function renderSecondAgentPanel(
	props: StepNavigationProps & {
		entrance: RefCallback<HTMLElement>
		loggedIn: boolean
		hasSecondMcpClient: boolean
		secondAgentGiftActive?: boolean
		connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
		firstAgent: McpClientKind | null
		selectedAgent: McpClientKind | null
		selectedAgentLabel: string | null
		agentChooser: OnboardingAgentChooserPick | null
		mcpServerUrl: string
		mcpHighlights: Record<string, HighlightedCode>
		accessWinMemorySubject?: string | null
		persistedPackageName?: string | null
		awaitingConnect?: boolean
	},
) {
	const selectedAgent =
		props.selectedAgent === 'other' ? null : props.selectedAgent
	const selectedAgentLabel = selectedAgent ? props.selectedAgentLabel : null
	const connectedAgents = props.connectedAgents ?? []
	const greyed = onboardingSecondAgentGreyedPresentation(connectedAgents)
	const accessWinMade = onboardingAccessWinMadeLine({
		memorySubject: props.accessWinMemorySubject,
		packageName: props.persistedPackageName,
	})
	return (
		<section
			id="onboarding-step-3"
			aria-labelledby="connect-second-title"
			data-testid="onboarding-connect-second-agent"
			css={wizardPanelCss}
			ref={props.entrance}
		>
			{renderAgentPanelHead({
				kicker: 'Step 3',
				titleId: 'connect-second-title',
				title: selectedAgentLabel
					? `Connect ${selectedAgentLabel}`
					: 'Connect a second agent',
				selectedAgent,
				changeHref: onboardingSecondAgentHref(null, props.search ?? ''),
				artSrc: '/images/kody-mcp-plug.webp',
				artAlt: 'Kody plugging a cable into a warmly glowing port on a laptop',
				tilt: '-1.5deg',
			})}
			{accessWinMade ? (
				<p data-testid="onboarding-access-win-made" css={accessWinMadeCss}>
					{accessWinMade}
				</p>
			) : null}
			{selectedAgent ? (
				<p css={panelLedeCss} data-testid="onboarding-second-agent-lede">
					{onboardingSecondAgentLede}
				</p>
			) : null}
			{renderConnectAgentStatus({
				loggedIn: props.loggedIn,
				hasMcpClient: props.hasSecondMcpClient,
				anyGrantCompletesStep: true,
				connectedAgents,
				selectedAgent,
				selectedAgentLabel,
				search: props.search,
				loginHref: onboardingSecondAgentHref(selectedAgent, props.search ?? ''),
				connectedLabel: onboardingSecondAgentConnectedStatusLabel(
					props.secondAgentGiftActive === true,
				),
			})}
			{renderConnectedAgentsLine(
				connectedAgentsOnCard(selectedAgent, connectedAgents),
			)}
			<OnboardingMcpClientTabs
				mcpServerUrl={props.mcpServerUrl}
				highlights={props.mcpHighlights}
				selectedAgent={selectedAgent}
				chooser={props.agentChooser ?? canonicalOnboardingAgentChooser()}
				search={props.search ?? ''}
				agentHref={onboardingSecondAgentHref}
				pickerLede={onboardingSecondAgentLede}
				ecosystemGroups={onboardingStep3EcosystemGroups}
				greyedAgents={greyed.greyedAgents}
				greyedReasons={greyed.greyedReasons}
				greyedTitles={greyed.greyedTitles}
			/>
			{selectedAgent ? (
				<div data-testid="onboarding-portability-proof" css={promptBlockCss}>
					<p css={proofLedeCss}>
						After it connects, paste this in the new agent. It looks up the
						portability guide and reuses what you already made — one short proof
						that Kody travels.
					</p>
					<CopyCard
						label="Portability proof"
						value={onboardingPortabilityProofPrompt}
						copyLabel={onboardingCopyPortabilityProofLabel}
					/>
					<p
						css={guidePointerCss}
						data-testid="onboarding-portability-guide-pointer"
					>
						Depth lives in the{' '}
						<SiteLink href={portabilityGuideHref} css={guideLinkCss}>
							portability guide
						</SiteLink>
						. The prompt tells your agent to retrieve it.
					</p>
				</div>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				connectWaitLabel={connectWaitLabel({
					awaitingConnect: props.awaitingConnect,
					selectedAgent,
					selectedAgentLabel,
					connectedAgents,
					connected: cardShowsConnectedStatus({
						hasMcpClient: props.hasSecondMcpClient,
						selectedAgent,
						connectedAgents,
						anyGrantCompletesStep: true,
					}),
				})}
				lastStep={{
					exploreHref: onboardingExplorePackagesHref(),
				}}
			/>
		</section>
	)
}

function renderAgentPanelHead(props: {
	kicker: string
	titleId: string
	title: string
	selectedAgent: McpClientKind | null
	changeHref: string
	artSrc: string
	artAlt: string
	tilt: string
}) {
	return (
		<div css={panelHeadCss}>
			<div>
				<p css={panelKickerCss}>{props.kicker}</p>
				<div css={panelTitleRowCss}>
					<h2 id={props.titleId} tabIndex={-1} css={panelTitleCss}>
						{props.title}
					</h2>
					{props.selectedAgent ? (
						<AgentPickerMark
							agent={props.selectedAgent}
							testId="onboarding-agent-title-mark"
						/>
					) : null}
				</div>
				<div
					data-testid="onboarding-agent-selection-meta"
					css={agentSelectionMetaCss}
					aria-hidden={props.selectedAgent ? undefined : 'true'}
				>
					<div css={changeSelectionSlotCss}>
						{props.selectedAgent ? (
							<SiteLink
								href={props.changeHref}
								data-testid="onboarding-agent-change"
								data-prevent-scroll-reset=""
								css={changeSelectionCss}
							>
								Change selection
							</SiteLink>
						) : null}
					</div>
				</div>
			</div>
			<img
				data-panel-art
				src={publicAsset(props.artSrc)}
				width={627}
				height={627}
				loading="lazy"
				alt={props.artAlt}
				style={{ '--tilt': props.tilt } as CSSProperties}
				css={panelArtCss}
			/>
		</div>
	)
}

function renderConnectedAgentsLine(
	agents: ReadonlyArray<OnboardingConnectedAgentListItem> | undefined,
) {
	const connectedItems = uniqueOnboardingConnectedAgents(agents ?? [])
	const connectedLabels = onboardingConnectedAgentLabelsLine(connectedItems)
	if (connectedItems.length === 0) return null
	return (
		<p
			css={connectedAgentsLineCss}
			data-testid="onboarding-connected-agents"
			aria-label={connectedLabels ?? undefined}
		>
			<span aria-hidden="true">
				Connected:{' '}
				{connectedItems.map((agent, index) => (
					<span key={agent.label}>
						{onboardingConnectedListSeparator(index, connectedItems.length)}
						<span
							css={connectedAgentItemCss}
							data-testid="onboarding-connected-agent"
							data-agent-kind={agent.kind ?? 'unknown'}
						>
							{agent.kind && agent.kind !== 'other' ? (
								<AgentPickerMark agent={agent.kind} size="inline" />
							) : null}
							{agent.label}
						</span>
					</span>
				))}
			</span>
		</p>
	)
}

function connectedAgentsOnCard(
	selectedAgent: McpClientKind | null,
	agents: ReadonlyArray<OnboardingConnectedAgentListItem> | undefined,
) {
	const unique = uniqueOnboardingConnectedAgents(agents ?? [])
	if (selectedAgent === 'other') {
		return unique.filter(
			(agent) => agent.kind == null || agent.kind === 'other',
		)
	}
	if (!selectedAgent) return unique
	return unique.filter((agent) =>
		connectedKindMatchesCard(selectedAgent, agent.kind),
	)
}

/**
 * The Step 1 Cursor card is the generic host. A grant we can tell is Local or
 * Cloud still belongs on that card. Grok Bot stays its own host.
 */
function connectedKindMatchesCard(
	card: McpClientKind,
	kind: McpClientKind | null | undefined,
) {
	if (!kind) return false
	if (kind === card) return true
	return (
		card === 'cursor' && (kind === 'cursor-local' || kind === 'cursor-cloud')
	)
}

function selectedAgentIsConnected(
	selectedAgent: McpClientKind | null,
	agents: ReadonlyArray<OnboardingConnectedAgentListItem> | undefined,
) {
	if (!selectedAgent || selectedAgent === 'other') return false
	return connectedAgentsOnCard(selectedAgent, agents).length > 0
}

function cardShowsConnectedStatus(props: {
	hasMcpClient: boolean
	selectedAgent: McpClientKind | null
	connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
	/** Step 3 is done when any second grant exists, not when the selected kind matches. */
	anyGrantCompletesStep?: boolean
}) {
	if (!props.hasMcpClient) return false
	if (props.anyGrantCompletesStep) return true
	if (!props.selectedAgent) return true
	if (props.selectedAgent === 'other') {
		return (props.connectedAgents ?? []).some(
			(agent) => agent.kind == null || agent.kind === 'other',
		)
	}
	return selectedAgentIsConnected(props.selectedAgent, props.connectedAgents)
}

function waitingForAgentLabel(selectedAgentLabel: string | null) {
	return selectedAgentLabel
		? `Waiting for ${selectedAgentLabel} to connect…`
		: 'Waiting for your agent to connect…'
}

function connectWaitLabel(props: {
	awaitingConnect?: boolean
	hasMcpClient?: boolean
	selectedAgent: McpClientKind | null
	selectedAgentLabel: string | null
	connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
	connected?: boolean
}) {
	if (!props.awaitingConnect) return null
	const genericHostDone =
		props.selectedAgent === 'other' &&
		(props.connectedAgents ?? []).some(
			(agent) => agent.kind == null || agent.kind === 'other',
		)
	if (
		props.connected ||
		genericHostDone ||
		selectedAgentIsConnected(props.selectedAgent, props.connectedAgents)
	) {
		return null
	}
	return waitingForAgentLabel(props.selectedAgentLabel)
}

function renderConnectAgentStatus(props: {
	loggedIn: boolean
	hasMcpClient: boolean
	connectedAgents?: ReadonlyArray<OnboardingConnectedAgentListItem>
	selectedAgent: McpClientKind | null
	selectedAgentLabel: string | null
	search?: string
	loginHref?: string
	connectedLabel?: string
	anyGrantCompletesStep?: boolean
}) {
	if (cardShowsConnectedStatus(props)) {
		return (
			<div
				css={connectStatusCss}
				role="status"
				aria-live="polite"
				data-connected="true"
			>
				{connectStatusContent({
					connected: true,
					connectedLabel:
						props.connectedLabel ??
						(props.selectedAgent === 'other' || !props.selectedAgentLabel
							? 'You are connected'
							: `${props.selectedAgentLabel} is connected`),
					waitingLabel: 'Waiting for your agent to connect…',
				})}
			</div>
		)
	}
	if (!props.selectedAgent) return null
	if (!props.loggedIn) {
		const resumeHref =
			props.loginHref ??
			onboardingAgentHref(props.selectedAgent, props.search ?? '')
		return (
			<SiteLink
				href={buildAuthLink(routes.login.href(), resumeHref)}
				data-testid="onboarding-agent-login"
				css={agentLoginCss}
			>
				{props.selectedAgentLabel
					? `Log in to connect ${props.selectedAgentLabel}`
					: 'Log in to connect'}
			</SiteLink>
		)
	}
	return null
}

const wizardPanelCss: CSSObject = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: 'clamp(1.4rem, 3.5vw, 2.2rem)',
	display: 'grid',
	gap: '1.15rem',
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const panelHeadCss: CSSObject = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '1rem',
	overflow: 'visible',
	'@media (max-width: 720px)': {
		flexDirection: 'column-reverse' as const,
		alignItems: 'flex-start',
	},
}

const panelKickerCss: CSSObject = {
	margin: '0 0 0.35rem',
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const panelTitleRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.65rem',
	flexWrap: 'wrap' as const,
}

const panelTitleCss: CSSObject = {
	margin: 0,
	fontSize: 'clamp(1.4rem, 2.4vw, 1.75rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	lineHeight: 1.15,
}

const agentSelectionMetaCss: CSSObject = {
	display: 'grid',
	justifyItems: 'start',
	width: 'fit-content',
	marginTop: '0.35rem',
	minHeight: '1.25rem',
}

const changeSelectionSlotCss: CSSObject = {
	display: 'grid',
	alignItems: 'center',
	minHeight: '1.25rem',
}

const changeSelectionCss: CSSObject = {
	...primaryLinkCss,
	display: 'inline-block',
	fontSize: typography.fontSize.sm,
}

const agentLoginCss: CSSObject = {
	...getPillButtonCss({ size: 'sm' }),
	width: 'fit-content',
}

const panelArtCss: CSSObject = {
	flex: 'none',
	width: 'clamp(90px, 11vw, 130px)',
	height: 'auto',
	rotate: 'var(--tilt, 0deg)',
	margin: '-0.4rem 0 -1.4rem',
	'@media (max-width: 720px)': {
		width: 'min(34%, 130px)',
		margin: '-0.4rem 0 0',
		alignSelf: 'flex-end',
	},
}

const panelLedeCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '68ch',
}

const connectedAgentsLineCss: CSSObject = {
	...panelLedeCss,
	lineHeight: 1.65,
}

const connectedAgentItemCss: CSSObject = {
	whiteSpace: 'nowrap' as const,
}

const accessWinMadeCss: CSSObject = {
	margin: 0,
	width: 'fit-content',
	maxWidth: '100%',
	padding: '0.22rem 0.7rem',
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.primarySoft,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	lineHeight: 1.35,
}

const guidePointerCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const guideLinkCss: CSSObject = {
	...primaryLinkCss,
	fontWeight: 600,
}

const proofLedeCss: CSSObject = {
	...panelLedeCss,
	fontWeight: 550,
	color: colors.text,
}

const promptBlockCss: CSSObject = {
	display: 'grid',
	gap: '0.75rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}

const unconnectedNoticeCss: CSSObject = {
	margin: 0,
	color: colors.text,
	fontWeight: 650,
}

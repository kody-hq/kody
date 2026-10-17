/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { useRouter } from '@tanstack/react-router'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	type OnboardingAgentViewport,
	canonicalOnboardingAgentChooser,
	onboardingAgentHelp,
	onboardingAgentIconName,
	onboardingAgentLabel,
	onboardingAgentViewport,
	onboardingNotListedAgentIds,
	onboardingPickerAgentIds,
	onboardingViewportCss,
} from '#client/routes/onboarding-mcp-clients.ts'
import { renderIcon } from '../components/icon.tsx'
import {
	type OnboardingSecondAgentDisableReason,
	type OnboardingStep3EcosystemGroup,
	onboardingSecondAgentDisableHint,
} from '#universal/onboarding-agent-ecosystems.ts'
import { onboardingAgentHref } from '#universal/onboarding-process.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { AgentAuthCallout } from './onboarding-agent-auth-callout.tsx'
import {
	renderPanelContent,
	renderPanelWarning,
} from './onboarding-mcp-client-panels.tsx'
import { onboardingAgentPickerPrefetchHrefs } from '#client/routes/onboarding-picker-prefetch.ts'

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
	selectedAgent?: McpClientKind | null
	chooser?: OnboardingAgentChooserPick | null
	search?: string
	agentHref?: (agent: McpClientKind | null, search?: string) => string
	pickerLede?: string
	greyedAgents?: ReadonlyArray<McpClientKind>
	greyedReasons?: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	>
	greyedTitles?: Partial<Record<McpClientKind, string>>
	greyedReason?: string | null
	ecosystemGroups?: ReadonlyArray<OnboardingStep3EcosystemGroup>
}

function AgentMarkIcon(props: {
	icon: string | null
	size?: 'picker' | 'inline'
}) {
	const inline = props.size === 'inline'
	if (!props.icon) {
		return renderIcon('dots-horizontal', {
			size: inline ? '1cap' : '22',
		})
	}
	return (
		<img
			src={publicAsset(`/images/icons/${props.icon}.svg`)}
			alt=""
			width={inline ? undefined : 28}
			height={inline ? undefined : 28}
			css={inline ? pickerIconImgInlineCss : pickerIconImgCss}
		/>
	)
}

export function AgentPickerMark(props: {
	agent: McpClientKind
	testId?: string
	size?: 'picker' | 'inline'
}) {
	const desktopIcon = onboardingAgentIconName(props.agent, 'desktop')
	const mobileIcon = onboardingAgentIconName(props.agent, 'mobile')
	const size = props.size ?? 'picker'
	return (
		<span
			css={size === 'inline' ? pickerMarkInlineCss : pickerMarkCss}
			aria-hidden="true"
			data-testid={props.testId}
			data-mark-size={size}
		>
			{desktopIcon === mobileIcon ? (
				<AgentMarkIcon icon={desktopIcon} size={size} />
			) : (
				<>
					<span
						css={onboardingViewportCss(
							'desktop-only',
							size === 'inline' ? 'inline-block' : 'grid',
						)}
					>
						<AgentMarkIcon icon={desktopIcon} size={size} />
					</span>
					<span
						css={onboardingViewportCss(
							'mobile-only',
							size === 'inline' ? 'inline-block' : 'grid',
						)}
					>
						<AgentMarkIcon icon={mobileIcon} size={size} />
					</span>
				</>
			)}
		</span>
	)
}

function AgentSurfaceLabel(props: { agent: McpClientKind }) {
	const desktop = onboardingAgentLabel(props.agent, 'desktop')
	const mobile = onboardingAgentLabel(props.agent, 'mobile')
	if (desktop === mobile) return desktop
	return (
		<>
			<span css={onboardingViewportCss('desktop-only', 'inline')}>
				{desktop}
			</span>
			<span css={onboardingViewportCss('mobile-only', 'inline')}>{mobile}</span>
		</>
	)
}

function AgentHelpLink(props: {
	agent: McpClientKind
	surface: OnboardingAgentSurface
}) {
	const help = onboardingAgentHelp(props.agent, props.surface)
	return (
		<p css={agentHelpCss}>
			Need help?{' '}
			<SiteLink
				href={help.href}
				target="_blank"
				rel="noreferrer noopener"
				data-testid="onboarding-agent-help"
			>
				{help.label}
			</SiteLink>
		</p>
	)
}

/**
 * Step 1: pick one agent, then show only that host's install path and
 * authenticate hint. Featured hosts are the first chooser; other named
 * hosts are under More; **Not listed** is the generic MCP URL path.
 * Step 3 passes `ecosystemGroups` and renders those groups instead.
 */
export function OnboardingMcpClientTabs(props: OnboardingMcpClientTabsProps) {
	const router = useRouter()
	const { mcpServerUrl, highlights } = props
	const selectedAgent = props.selectedAgent ?? null
	const chooser = props.chooser ?? canonicalOnboardingAgentChooser()
	const search = props.search ?? ''
	const agentHref = props.agentHref ?? onboardingAgentHref
	const greyedAgents = props.greyedAgents ?? []
	const greyedReasons = props.greyedReasons ?? {}
	const greyedTitles = props.greyedTitles ?? {}
	const ecosystemGroups = props.ecosystemGroups

	useEffect(() => {
		const prefetchAgentIds = ecosystemGroups?.flatMap((group) => group.agents)
		const hrefs = onboardingAgentPickerPrefetchHrefs(
			selectedAgent,
			chooser,
			search,
			agentHref,
			prefetchAgentIds,
		)
		for (const href of hrefs)
			void router.preloadRoute({ to: href }).catch(() => {})
	}, [router, selectedAgent, chooser, search, agentHref, ecosystemGroups])
	if (!selectedAgent && ecosystemGroups && ecosystemGroups.length > 0) {
		return (
			<div
				data-testid="onboarding-agent-picker"
				data-picker="ecosystem"
				css={installLayoutCss}
			>
				<p css={pickerLedeCss} id="onboarding-agent-picker-label">
					{props.pickerLede ??
						'Choose the agent you want to connect first. You can add others later.'}
				</p>
				<div data-testid="onboarding-ecosystem-picker" css={ecosystemPickerCss}>
					{ecosystemGroups.map((group) => {
						const labelId = `onboarding-ecosystem-${group.id}-label`
						return (
							<section
								key={group.id}
								data-testid={`onboarding-ecosystem-${group.id}`}
								aria-labelledby={labelId}
								css={ecosystemGroupCss}
							>
								<h3 id={labelId} css={ecosystemLabelCss}>
									{group.label}
								</h3>
								<AgentPickerGrid
									ids={group.agents.map((id) => ({
										id,
										viewport: 'both' as const,
									}))}
									labelledBy={labelId}
									search={search}
									agentHref={agentHref}
									greyedAgents={greyedAgents}
									greyedReasons={greyedReasons}
									greyedTitles={greyedTitles}
									greyedReason={props.greyedReason ?? null}
								/>
							</section>
						)
					})}
				</div>
			</div>
		)
	}
	if (!selectedAgent) {
		return (
			<div data-testid="onboarding-agent-picker" css={installLayoutCss}>
				<p css={pickerLedeCss} id="onboarding-agent-picker-label">
					{props.pickerLede ??
						'Choose the agent you want to connect first. You can add others later.'}
				</p>
				<AgentPickerGrid
					ids={[...onboardingPickerAgentIds(chooser), 'other']}
					labelledBy="onboarding-agent-picker-label"
					search={search}
					agentHref={agentHref}
					greyedAgents={greyedAgents}
					greyedReasons={greyedReasons}
					greyedTitles={greyedTitles}
					greyedReason={props.greyedReason ?? null}
				/>
			</div>
		)
	}
	if (selectedAgent === 'other') {
		return (
			<div data-testid="onboarding-agent-not-listed" css={installLayoutCss}>
				<p css={pickerLedeCss} id="onboarding-agent-not-listed-label">
					Any of these what you're looking for?
				</p>
				<AgentPickerGrid
					ids={onboardingNotListedAgentIds(chooser)}
					labelledBy="onboarding-agent-not-listed-label"
					search={search}
					agentHref={agentHref}
					greyedAgents={greyedAgents}
					greyedReasons={greyedReasons}
					greyedTitles={greyedTitles}
					greyedReason={props.greyedReason ?? null}
				/>
				<p css={pickerLedeCss} id="onboarding-agent-not-listed-generic">
					Or, connect any agent that speaks MCP
				</p>
				<div
					data-testid="onboarding-agent-instructions"
					data-agent="other"
					css={installLayoutCss}
				>
					<AgentSurfaceInstructions
						agent="other"
						mcpServerUrl={mcpServerUrl}
						highlights={highlights}
					/>
				</div>
			</div>
		)
	}
	return (
		<div
			data-testid="onboarding-agent-instructions"
			data-agent={selectedAgent}
			css={installLayoutCss}
		>
			<AgentSurfaceInstructions
				agent={selectedAgent}
				mcpServerUrl={mcpServerUrl}
				highlights={highlights}
			/>
		</div>
	)
}

/**
 * One host's install path: desktop and phone surfaces both render and CSS
 * shows the one that matches the viewport, followed by the help link, any
 * host caveat, and the authenticate callout. Shared with Add connection on
 * `/@slug/-/agents/new`.
 */
export function AgentSurfaceInstructions(props: {
	agent: McpClientKind
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
}) {
	return (
		<>
			<div
				data-surface="desktop"
				css={[
					onboardingViewportCss('desktop-only', 'grid'),
					agentSurfaceStackCss,
				]}
			>
				<div css={selectedPanelCss}>
					{renderPanelContent(
						props.agent,
						props.mcpServerUrl,
						props.highlights,
						'desktop',
					)}
					<AgentHelpLink agent={props.agent} surface="desktop" />
					{renderPanelWarning(props.agent, 'desktop')}
				</div>
				<AgentAuthCallout
					agent={props.agent}
					surface="desktop"
					mcpServerUrl={props.mcpServerUrl}
				/>
			</div>
			<div
				data-surface="mobile"
				css={[
					onboardingViewportCss('mobile-only', 'grid'),
					agentSurfaceStackCss,
				]}
			>
				<div css={selectedPanelCss}>
					{renderPanelContent(
						props.agent,
						props.mcpServerUrl,
						props.highlights,
						'mobile',
					)}
					<AgentHelpLink agent={props.agent} surface="mobile" />
					{renderPanelWarning(props.agent, 'mobile')}
				</div>
				<AgentAuthCallout
					agent={props.agent}
					surface="mobile"
					mcpServerUrl={props.mcpServerUrl}
				/>
			</div>
		</>
	)
}

/**
 * The client wall. Entries given as bare ids follow the onboarding
 * viewport split (desktop-only hosts hide on a phone); pass
 * `{ id, viewport: 'both' }` entries to show every card everywhere, which
 * is what Connect an agent on `/@slug/-/agents/new` does.
 *
 * `greyedAgents` marks hosts Kody already knows are connected. Those cards
 * stay selectable so someone can re-view connect steps (second login, new
 * machine, reinstall) — Connected is a badge, not a dead end.
 */
export function AgentPickerGrid(props: {
	ids:
		| Array<McpClientKind>
		| Array<{ id: McpClientKind; viewport: OnboardingAgentViewport }>
	labelledBy: string
	search?: string
	agentHref: (agent: McpClientKind | null, search?: string) => string
	greyedAgents?: ReadonlyArray<McpClientKind>
	greyedReasons?: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	>
	greyedTitles?: Partial<Record<McpClientKind, string>>
	greyedReason?: string | null
}) {
	return (
		<ul aria-labelledby={props.labelledBy} css={pickerGridCss}>
			{props.ids.map((entry) => {
				const id = typeof entry === 'string' ? entry : entry.id
				const viewport =
					typeof entry === 'string'
						? onboardingAgentViewport(id)
						: entry.viewport
				const shown = viewport === 'none' ? 'both' : viewport
				const greyedAgents = props.greyedAgents ?? []
				const greyedReasons = props.greyedReasons ?? {}
				const greyedTitles = props.greyedTitles ?? {}
				const search = props.search ?? ''
				const connectedMark = greyedAgents.includes(id)
				const reason = greyedReasons[id] ?? 'connected'
				const title = greyedTitles[id] ?? props.greyedReason ?? null
				return (
					<li key={id} css={onboardingViewportCss(shown, 'list-item')}>
						<SiteLink
							href={props.agentHref(id, search)}
							data-testid={`onboarding-agent-${id}`}
							data-prevent-scroll-reset=""
							data-greyed={connectedMark ? 'true' : undefined}
							data-greyed-reason={connectedMark ? reason : undefined}
							title={connectedMark ? (title ?? undefined) : undefined}
							css={connectedMark ? pickerCardConnectedMarkCss : pickerCardCss}
						>
							<AgentPickerMark agent={id} />
							<strong>
								<AgentSurfaceLabel agent={id} />
							</strong>
							{connectedMark ? (
								<span css={connectedMarkHintCss}>
									{onboardingSecondAgentDisableHint(reason)}
								</span>
							) : null}
						</SiteLink>
					</li>
				)
			})}
		</ul>
	)
}

const installLayoutCss: CSSObject = {
	display: 'grid',
	gap: '1.15rem',
}

/* Warning and authenticate callouts are siblings of the instruction
   stack. Without a gap they sit flush and read as one block. */
const agentSurfaceStackCss: CSSObject = {
	gap: '1rem',
	alignContent: 'start' as const,
}

const pickerLedeCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '72ch',
}

const ecosystemPickerCss: CSSObject = {
	display: 'grid',
	gap: '1.25rem',
}

const ecosystemGroupCss: CSSObject = {
	display: 'grid',
	gap: '0.5rem',
}

const ecosystemLabelCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
}

const pickerGridCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	alignItems: 'stretch',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(10.5rem, 100%), 1fr))',
	gap: '0.75rem',
}

const pickerCardCss: CSSObject = {
	display: 'grid',
	justifyItems: 'center',
	alignContent: 'center',
	gap: '0.55rem',
	width: '100%',
	height: '100%',
	minWidth: 0,
	padding: '1.05rem 0.85rem',
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	color: colors.text,
	cursor: 'pointer',
	textDecoration: 'none',
	boxSizing: 'border-box' as const,
	textAlign: 'center' as const,
	font: `650 0.98rem/1.25 ${typography.fontFamilyBody}`,
	transition: `border-color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			transform: 'translateY(-2px)',
		},
	},
	'&:active': { transform: 'translateY(0)' },
	'@media (prefers-reduced-motion: reduce)': {
		transition: `border-color 160ms ${transitions.easeOut}`,
		'&:hover': { transform: 'none' },
		'&:active': { transform: 'none' },
	},
}

const pickerCardConnectedMarkCss: CSSObject = {
	...pickerCardCss,
	borderStyle: 'dashed' as const,
}

const connectedMarkHintCss: CSSObject = {
	font: `550 0.72rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const pickerMarkCss: CSSObject = {
	display: 'grid',
	placeItems: 'center',
	flex: 'none',
	width: '1.75rem',
	height: '1.75rem',
	color: colors.text,
}

const pickerMarkInlineCss: CSSObject = {
	display: 'inline-block',
	width: '1cap',
	height: '1cap',
	overflow: 'hidden',
	verticalAlign: 'baseline',
	marginInlineEnd: '0.25em',
	color: colors.text,
}

const pickerIconImgCss: CSSObject = {
	display: 'block',
	width: '1.75rem',
	height: '1.75rem',
	objectFit: 'contain' as const,
	'@media (prefers-color-scheme: dark)': {
		filter: 'invert(1)',
	},
}

const pickerIconImgInlineCss: CSSObject = {
	display: 'block',
	width: '1cap',
	height: '1cap',
	objectFit: 'contain' as const,
	'@media (prefers-color-scheme: dark)': {
		filter: 'invert(1)',
	},
}

const selectedPanelCss: CSSObject = {
	display: 'grid',
	gap: '0.9rem',
	minWidth: 0,
	color: colors.text,
	'@media (prefers-reduced-motion: no-preference)': {
		transition: `opacity 240ms ${transitions.easeOut}, translate 240ms ${transitions.easeOut}`,
	},
	'@starting-style': {
		opacity: 0,
		translate: '0 6px',
	},
	'& > p': {
		margin: 0,
		color: colors.textMuted,
		maxWidth: '72ch',
	},
	'& > p a': {
		color: colors.primaryText,
	},
	'& code': {
		font: '500 0.88em ui-monospace, "SF Mono", Menlo, monospace',
		color: colors.text,
		backgroundColor: colors.background,
		border: `1px solid ${colors.border}`,
		borderRadius: '6px',
		padding: '0.1em 0.4em',
	},
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
}

const agentHelpCss: CSSObject = {
	// Beat `selectedPanelCss` `& > p { margin: 0 }` so this sits off the
	// authenticate banner.
	'&&': {
		margin: '0 0 1rem',
	},
	fontSize: typography.fontSize.sm,
}

/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type CSSObject } from '@emotion/react'
import {
	useEffect,
	useState,
	useRef,
	useCallback,
	useMemo,
	useSyncExternalStore,
	type CSSProperties,
} from 'react'
import { useRouter } from '@tanstack/react-router'
import { type OnboardingPayload } from '#universal/onboarding-types.ts'
import {
	onboardingWizardStepHref,
	onboardingWizardStepByNumber,
	type OnboardingLocation,
	resolveOnboardingFirstAgentKind,
	onboardingSecondAgentHref,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import { resolveOnboardingStep3SelectedAgent } from '#universal/onboarding-agent-ecosystems.ts'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	onboardingAgentLabel,
} from '#universal/onboarding-mcp-clients.ts'
import {
	readRememberedOnboardingAgentChooser,
	rememberOnboardingAgentChooser,
} from '#client/routes/onboarding-agent-chooser-session.ts'
import {
	readRememberedOnboardingSelectedAgent,
	rememberOnboardingSelectedAgent,
} from '#client/routes/onboarding-selected-agent-session.ts'
import {
	closeOnboardingMcpOAuthPopupIfOpened,
	listenForOnboardingMcpOAuthDone,
} from '#client/mcp-oauth-popup.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { resolveOnboardingPendingVerificationPath } from '#client/routes/onboarding-redirect.ts'
import { onboardingCopiedConnectActionEvent } from '../components/copy-text-button.tsx'
import {
	renderAccessPanel as AccessPanel,
	renderConnectAgentPanel as ConnectAgentPanel,
	renderSecondAgentPanel as SecondAgentPanel,
} from './onboarding-wizard-panels.tsx'
import { WizardStepsNav } from './onboarding-wizard-chrome.tsx'
import { ProviderIcon } from '../components/provider-icons.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { routes } from '#universal/routes.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
const subscribeHydration = () => () => {}
export function OnboardingRoute({
	payload,
	selection,
	initialAgentChooser,
	refresh,
}: {
	payload: OnboardingPayload
	selection: OnboardingLocation | null
	initialAgentChooser: OnboardingAgentChooserPick
	refresh: () => void
}) {
	const router = useRouter()
	const currentHref = useMatchedPageScope().pageLocation.href
	const search = new URL(currentHref, 'http://localhost').search
	const hydrated = useSyncExternalStore(
		subscribeHydration,
		() => true,
		() => false,
	)
	// SSR and hydration use the same server pick. Later SPA mounts reuse the
	// remembered order, while progress polls cannot reshuffle this wizard.
	const [agentChooser] = useState(() =>
		hydrated
			? (readRememberedOnboardingAgentChooser() ?? initialAgentChooser)
			: initialAgentChooser,
	)
	useEffect(() => rememberOnboardingAgentChooser(agentChooser), [agentChooser])
	const storedAgent = useMemo(
		() => (hydrated ? readRememberedOnboardingSelectedAgent() : null),
		[hydrated],
	)

	const [connectActionAgent, setConnectActionAgent] =
		useState<McpClientKind | null>(null)
	const [selectedRememberedAgent, setRememberedAgent] =
		useState<McpClientKind | null>(null)
	const rememberedAgent = selectedRememberedAgent ?? storedAgent
	const sectionRef = useRef<HTMLElement>(null)
	const animationArmed = useRef(false)

	useEffect(() => {
		closeOnboardingMcpOAuthPopupIfOpened()
	}, [])
	const {
		loggedIn,
		mcpServerUrl,
		discoveryPrompt,
		hasMcpClient,
		hasAccessWin,
		hasSecondMcpClient,
		connectedAgents,
		accessWinMemorySubject,
		persistedPackageName,
	} = payload
	const mcpHighlights = payload.mcpHighlights ?? {}
	const featuredPlatformIntegrations =
		payload.featuredPlatformIntegrations ?? []
	const secondAgentGiftActive = payload.secondAgentStandardGift?.active === true
	const activeStep: OnboardingWizardStepNumber = selection?.valid
		? selection.step
		: hasMcpClient
			? 2
			: 1
	const selectedAgent = selection?.valid ? selection.agent : null
	const visibleSelectedAgent =
		activeStep === 3
			? resolveOnboardingStep3SelectedAgent(selectedAgent)
			: selectedAgent
	const selectedAgentLabel = visibleSelectedAgent
		? onboardingAgentLabel(visibleSelectedAgent)
		: null
	const firstAgent = resolveOnboardingFirstAgentKind(
		rememberedAgent,
		connectedAgents,
	)
	const connectedAgentLabel =
		firstAgent && firstAgent !== 'other'
			? onboardingAgentLabel(firstAgent)
			: null
	const awaitingConnect =
		visibleSelectedAgent != null && connectActionAgent === visibleSelectedAgent
	function buildStepHref(step: OnboardingWizardStepNumber, href = currentHref) {
		return onboardingWizardStepHref(
			step,
			new URL(href, 'http://localhost').search,
		)
	}
	function selectStep(step: OnboardingWizardStepNumber) {
		animationArmed.current = true
		void router
			.navigate({ to: buildStepHref(step), resetScroll: false })
			.then(() =>
				document
					.getElementById(onboardingWizardStepByNumber(step).panelId)
					?.querySelector('h2')
					?.focus({ preventScroll: true }),
			)
	}
	const [previousSelectedAgent, setPreviousSelectedAgent] =
		useState(selectedAgent)
	if (
		activeStep === 1 &&
		selectedAgent &&
		previousSelectedAgent !== selectedAgent
	) {
		setPreviousSelectedAgent(selectedAgent)
		setRememberedAgent(selectedAgent)
	}
	useEffect(() => {
		if (activeStep === 1 && selectedAgent) {
			rememberOnboardingSelectedAgent(selectedAgent)
		}
	}, [activeStep, selectedAgent])
	useEffect(() => {
		if (activeStep === 3 && selectedAgent && !visibleSelectedAgent)
			void router.navigate({
				to: onboardingSecondAgentHref(null, search),
				replace: true,
				resetScroll: false,
			})
	}, [activeStep, selectedAgent, visibleSelectedAgent, router, search])
	useEffect(() => {
		const node = sectionRef.current
		if (!node) return
		const arm = () => {
			if (visibleSelectedAgent) setConnectActionAgent(visibleSelectedAgent)
		}
		node.addEventListener(onboardingCopiedConnectActionEvent, arm)
		return () =>
			node.removeEventListener(onboardingCopiedConnectActionEvent, arm)
	}, [visibleSelectedAgent])
	function noteOnboardingConnectAction(event: { target: EventTarget | null }) {
		if (
			event.target instanceof Element &&
			event.target.closest('[data-onboarding-connect-action]') &&
			visibleSelectedAgent
		)
			setConnectActionAgent(visibleSelectedAgent)
	}
	const previousConnection = useRef({
		username: payload.username,
		connected: payload.hasMcpClient,
	})
	useEffect(() => {
		const previous = previousConnection.current
		previousConnection.current = {
			username: payload.username,
			connected: payload.hasMcpClient,
		}
		if (payload.loggedIn && !payload.emailVerified) {
			void router.navigate({
				href: resolveOnboardingPendingVerificationPath(
					normalizeRedirectTo(new URLSearchParams(search).get('redirectTo')),
				),
				replace: true,
			})
			return
		}
		if (
			previous.username === payload.username &&
			!previous.connected &&
			payload.hasMcpClient
		) {
			animationArmed.current = true
			void router.navigate({
				to: onboardingWizardStepHref(2, search),
				resetScroll: false,
			})
		}
	}, [
		payload.username,
		payload.loggedIn,
		payload.emailVerified,
		payload.hasMcpClient,
		router,
		search,
	])
	useEffect(() => {
		const controller = new AbortController()
		listenForOnboardingMcpOAuthDone(refresh, controller.signal)
		return () => controller.abort()
	}, [refresh])

	const entrance = useCallback((node: HTMLElement | null) => {
		if (
			!node ||
			!animationArmed.current ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		)
			return
		node.animate(
			[
				{ opacity: 0, translate: '0 12px' },
				{ opacity: 1, translate: '0 0' },
			],
			{ duration: 360, easing: transitions.easeOutValue },
		)
		const art = node.querySelector('[data-panel-art]')
		if (art instanceof HTMLElement)
			art.animate(
				[
					{ opacity: 0, rotate: '0deg', scale: '0.92' },
					{
						opacity: 1,
						rotate: art.style.getPropertyValue('--tilt') || '0deg',
						scale: '1',
					},
				],
				{ duration: 560, easing: transitions.easeOutValue },
			)
	}, [])

	return (
		<section
			css={onboardCss}
			ref={sectionRef}
			onClick={noteOnboardingConnectAction}
		>
			<header css={onboardHeadCss}>
				<h1 data-rise style={{ '--rise': '0' } as CSSProperties}>
					Get started with <em>Kody</em>
				</h1>
			</header>

			{
				<>
					<WizardStepsNav
						activeStep={activeStep}
						hasMcpClient={hasMcpClient}
						accessWin={hasAccessWin}
						hasSecondMcpClient={hasSecondMcpClient}
						stepHref={(step) => buildStepHref(step, currentHref)}
					/>

					{activeStep === 1 ? (
						<ConnectAgentPanel
							{...{
								entrance,
								activeStep,
								onSelectStep: selectStep,
								hasMcpClient,
								loggedIn,
								connectedAgents,
								selectedAgent: visibleSelectedAgent,
								selectedAgentLabel,
								agentChooser,
								mcpServerUrl,
								mcpHighlights: mcpHighlights ?? {},
								search: search,
								awaitingConnect,
							}}
						/>
					) : null}

					{activeStep === 2 ? (
						<AccessPanel
							{...{
								entrance,
								activeStep,
								onSelectStep: selectStep,
								hasMcpClient,
								hasAccessWin,
								discoveryPrompt,
								featuredPlatformIntegrations,
								selectedAgentLabel: connectedAgentLabel,
								connectedAgents,
								search: search,
							}}
						/>
					) : null}

					{activeStep === 3 ? (
						<SecondAgentPanel
							{...{
								entrance,
								activeStep,
								onSelectStep: selectStep,
								loggedIn,
								hasSecondMcpClient,
								secondAgentGiftActive,
								connectedAgents,
								firstAgent,
								selectedAgent: visibleSelectedAgent,
								selectedAgentLabel,
								agentChooser,
								mcpServerUrl,
								mcpHighlights: mcpHighlights ?? {},
								search: search,
								accessWinMemorySubject,
								persistedPackageName,
								awaitingConnect,
							}}
						/>
					) : null}
				</>
			}

			<p
				data-rise
				style={{ '--rise': '1' } as CSSProperties}
				css={discordInviteWrapCss}
			>
				<SiteLink
					href={routes.discord.href()}
					css={discordInviteLinkCss}
					data-testid="onboarding-join-discord"
				>
					<ProviderIcon providerId="discord" size="1.1em" />
					Join the Discord
				</SiteLink>
			</p>
		</section>
	)
}

const onboardCss: CSSObject = {
	maxWidth: '56rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(3rem, 7vw, 5rem)',
}

/* The shirt fabric welcomes you in, same whisper as the landing close. */
const onboardHeadCss: CSSObject = {
	position: 'relative' as const,
	/* See `pageHeadCss`: the fabric is a backdrop, so it paints under the head. */
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-60% -12% -140%',
		background: `radial-gradient(ellipse 42% 58% at 68% 40%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.2rem, 4.5vw, 3.2rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.04,
	},
	'& h1 em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
}

/* Nested surfaces step down to the page ground so they read as wells. */
const discordInviteWrapCss: CSSObject = {
	margin: 'clamp(2rem, 4.5vw, 2.8rem) 0 0',
}

const discordInviteLinkCss: CSSObject = {
	...getGhostButtonCss({ size: 'sm' }),
	width: 'fit-content',
	gap: '0.4rem',
	padding: '0.4rem 0.85rem 0.4rem 0.65rem',
	font: `600 0.92rem/1 ${typography.fontFamilyBody}`,
}

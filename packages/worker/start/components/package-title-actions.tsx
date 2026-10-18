/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import {
	type ReactNode,
	createContext,
	useContext,
	useState,
	useRef,
	useEffect,
} from 'react'
import { SiteLink } from './site-link.tsx'
import { writeClipboardText } from '#client/clipboard.ts'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	FORK_AHEAD_TOOLTIP,
	FORK_OUTDATED_COPY_TOOLTIP,
	copyPromptTooltipCss,
} from './fork-outdated-copy-button.tsx'
import { renderIcon, type IconName } from './icon.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, typography } from '#universal/styles/tokens.ts'

const OTHER_ACCOUNT_FORK_TOOLTIP =
	'This was built by another user. Verify it before using. Click again to confirm fork.'
const FORK_LABEL = 'Fork'
const OPEN_FORK_LABEL = 'Open fork'
const COPY_SETUP_PROMPT_LABEL = 'Copy setup prompt'

const actionIconSize = '1.1em'
const statusTooltipId = 'package-title-status-tooltip'
const copyTooltipId = 'package-title-copy-tooltip'

import {
	type PackageRepoActions,
	type PackageRepoForkAction,
	type PackageRepoFollowAction,
	PACKAGE_FOLLOW_HASH,
	PACKAGE_FOLLOW_PANEL_ID,
} from '#universal/package-repo-actions.ts'
import { PackageFollowContext } from './package-follow-context.ts'
export { type PackageRepoActions } from '#universal/package-repo-actions.ts'

function hasPackageRepoActions(actions: PackageRepoActions | null) {
	if (!actions) return false
	return Boolean(
		actions.fork ||
		actions.publishHref ||
		actions.packageAppHref ||
		actions.packageAppOriginHref ||
		actions.follow,
	)
}

/**
 * The action group's contents, in visual order: outlined maintenance and
 * secondary actions first, then the one filled action the viewer came for
 * (Fork / Open fork for visitors, Open app for owners). Statuses that are not
 * actions (Featured, private, package marks) stay out of this group.
 */
export function renderPackageRepoActions(
	actions: PackageRepoActions | null,
): ReactNode {
	if (!actions || !hasPackageRepoActions(actions)) return null
	const install = actions.fork?.viewerInstall ?? null
	const publishIsPrimary = Boolean(
		actions.publishHref && !actions.packageAppHref && !actions.fork,
	)
	return (
		<>
			{actions.publishHref ? (
				<SiteLink
					href={actions.publishHref}
					data-testid="community-detail-source-ahead-badge"
					aria-describedby="package-repo-publish-tooltip"
					css={
						publishIsPrimary
							? packageActionPrimaryCss
							: packageActionSecondaryCss
					}
				>
					{renderIcon('arrow-up-right', { size: actionIconSize })}
					<span>Publish changes</span>
					<span
						id="package-repo-publish-tooltip"
						role="tooltip"
						aria-hidden="true"
					>
						Default-branch HEAD is newer than the live version. Review the
						changes, then publish them.
					</span>
				</SiteLink>
			) : null}
			{actions.follow ? renderFollowControl(actions.follow) : null}
			{actions.fork ? renderSetupPromptControl(install) : null}
			{install?.forkAhead && install.listingDiffHref ? (
				<SiteLink
					href={install.listingDiffHref}
					data-testid="community-detail-listing-fork-ahead-badge"
					aria-describedby="package-repo-fork-ahead-tooltip"
					css={packageActionSecondaryCss}
				>
					{renderIcon('git-fork', { size: actionIconSize })}
					<span>Fork ahead</span>
					<span
						id="package-repo-fork-ahead-tooltip"
						role="tooltip"
						aria-hidden="true"
					>
						{FORK_AHEAD_TOOLTIP}
					</span>
				</SiteLink>
			) : null}
			{actions.fork ? renderStatusControl(actions.fork) : null}
			{actions.packageAppHref ? (
				<a
					href={actions.packageAppHref}
					data-testid="open-package-app"
					css={packageActionPrimaryCss}
				>
					{renderIcon('share', { size: actionIconSize })}
					<span>Open app</span>
				</a>
			) : null}
			{actions.packageAppOriginHref &&
			actions.packageAppOriginHref !== actions.packageAppHref
				? renderPackageAppOriginLink(actions.packageAppOriginHref)
				: null}
		</>
	)
}

function renderPackageAppOriginLink(href: string) {
	let label = href
	try {
		label = new URL(href).host
	} catch {
		label = href
	}
	return (
		<a
			href={href}
			data-testid="package-app-origin-link"
			aria-label={`Open the app at ${label}`}
			css={packageActionSecondaryCss}
		>
			{renderIcon('share', { size: actionIconSize })}
			<span>{label}</span>
		</a>
	)
}

/**
 * Opens the Follow panel on the Repo tab. Other tabs follow the link there,
 * and signed-out visitors sign in first.
 */
function renderFollowControl(follow: PackageRepoFollowAction) {
	return <FollowControl follow={follow} />
}
function FollowControl({ follow }: { follow: PackageRepoFollowAction }) {
	const panel = useContext(PackageFollowContext)
	const following = panel?.following ?? follow.following
	const label = following ? 'Following' : 'Follow'
	const tooltip = following
		? 'Your workspace gets events from this. Change events or unfollow.'
		: follow.kind === 'repo'
			? 'Get pushes from this repository in your workspace.'
			: 'Get new versions and pushes from this in your workspace.'
	return (
		<SiteLink
			href={
				follow.loggedIn
					? `${follow.repoHref}${PACKAGE_FOLLOW_HASH}`
					: follow.loginHref
			}
			data-testid="package-follow-toggle"
			data-package-follow={follow.loggedIn ? follow.kind : undefined}
			data-following={following ? 'true' : 'false'}
			aria-controls={follow.loggedIn ? PACKAGE_FOLLOW_PANEL_ID : undefined}
			aria-expanded={follow.loggedIn ? (panel?.open ?? false) : undefined}
			onClick={
				panel && follow.loggedIn
					? (event) => {
							if (
								event.button !== 0 ||
								event.metaKey ||
								event.ctrlKey ||
								event.shiftKey ||
								event.altKey
							)
								return
							event.preventDefault()
							panel.toggle()
						}
					: undefined
			}
			aria-describedby="package-follow-tooltip"
			css={packageActionSecondaryCss}
		>
			{renderIcon(following ? 'check' : 'eye', {
				size: actionIconSize,
			})}
			<span>{label}</span>
			<span id="package-follow-tooltip" role="tooltip" aria-hidden="true">
				{tooltip}
			</span>
		</SiteLink>
	)
}

function renderStatusControl(fork: PackageRepoForkAction) {
	const install = fork.viewerInstall
	if (install?.listingAhead && install.listingAheadPrompt) {
		return renderLabeledControl({
			href: install.listingDiffHref,
			status: 'outdated',
			icon: 'link-break',
			label: 'Fork outdated',
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			testId: 'package-title-status',
			copyText: install.listingAheadPrompt,
			outdated: true,
			primary: false,
		})
	}
	if (install) {
		return renderLabeledControl({
			href:
				getCommunityPackageHrefFromName(install.targetName) ??
				'/account/packages',
			status: 'open',
			icon: 'arrow-up-right',
			label: OPEN_FORK_LABEL,
			tooltip: `Open your fork, ${install.targetName}.`,
			testId: 'package-title-status',
			primary: true,
		})
	}
	return renderInstallControl({
		...fork,
		icon: 'git-fork',
		label: FORK_LABEL,
		tooltip: OTHER_ACCOUNT_FORK_TOOLTIP,
	})
}

function renderSetupPromptControl(
	install: ViewerListingInstall | null,
): ReactNode {
	if (!install || install.listingAhead) return null
	if (install.status !== 'adaptation_required') return null
	const prompt = install.agentPrompt.trim()
	if (!prompt) return null
	return renderLabeledControl({
		status: null,
		icon: 'clipboard',
		label: COPY_SETUP_PROMPT_LABEL,
		tooltip: 'Copy the prompt that adapts your fork to your account.',
		testId: 'package-title-copy-setup',
		copyText: prompt,
		primary: false,
	})
}

export const PackageInstallContext = createContext({
	busy: false,
	confirmed: false,
	onInstall: () => {},
	onDisarm: () => {},
})
function renderInstallControl(input: {
	icon: IconName
	label: string
	tooltip: string
	loggedIn: boolean
	loginHref: string
	trusted: boolean
	listingId: string
}) {
	return <InstallControl input={input} />
}
function InstallControl({
	input,
}: {
	input: {
		icon: IconName
		label: string
		tooltip: string
		loggedIn: boolean
		loginHref: string
		trusted: boolean
		listingId: string
	}
}) {
	const install = useContext(PackageInstallContext)
	const label = install.busy
		? 'Installing'
		: install.confirmed
			? 'Confirm fork'
			: input.label

	const shared = {
		'data-testid': 'community-detail-install',
		'data-package-title-status': 'verify',
		'data-package-title-idle': 'verify',
		'data-package-title-listing': input.listingId,
		'data-title-idle-label': input.label,
		'data-title-idle-tooltip': input.tooltip,
		'data-community-install': '',
		'data-trusted': input.trusted ? 'true' : 'false',
		'aria-label': label,
		'aria-describedby': statusTooltipId,
	}
	const children = (
		<>
			<span data-title-status-icon hidden={install.busy}>
				{renderIcon(input.icon, { size: actionIconSize })}
			</span>
			<span data-title-status-spinner hidden={!install.busy} css={spinnerCss} />
			<span data-title-status-label>{label}</span>
			<span
				id={statusTooltipId}
				role="tooltip"
				data-title-status-tooltip
				aria-hidden="true"
			>
				{input.tooltip}
			</span>
			<span data-title-status-live aria-live="polite" css={visuallyHiddenCss} />
		</>
	)
	if (!input.loggedIn) {
		return (
			<SiteLink
				href={input.loginHref}
				{...shared}
				css={packageActionPrimaryCss}
			>
				{children}
			</SiteLink>
		)
	}
	return (
		<button
			type="button"
			{...shared}
			css={packageActionPrimaryCss}
			disabled={install.busy}
			onClick={install.onInstall}
			onBlur={install.onDisarm}
		>
			{children}
		</button>
	)
}

function renderLabeledControl(input: {
	href?: string | null
	status: 'open' | 'outdated' | null
	icon: IconName
	label: string
	tooltip: string
	testId: string
	copyText?: string
	outdated?: boolean
	primary: boolean
}) {
	return <IconControl input={input} />
}
function IconControl({
	input,
}: {
	input: {
		href?: string | null
		status: 'open' | 'outdated' | null
		icon: IconName
		label: string
		tooltip: string
		testId: string
		copyText?: string
		outdated?: boolean
		primary: boolean
	}
}) {
	const [feedback, setFeedback] = useState<string | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			if (timer.current) clearTimeout(timer.current)
		}
	}, [])
	async function copy(event: React.MouseEvent) {
		if (!input.copyText) return
		event.preventDefault()
		let text = 'Copied'
		try {
			await writeClipboardText(input.copyText)
		} catch {
			text = 'Copy failed'
		}
		if (!mounted.current) return
		setFeedback(text)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => setFeedback(null), 2000)
	}

	const tooltipId = input.copyText ? copyTooltipId : statusTooltipId
	const copyAttrs = input.copyText
		? {
				'data-copy-prompt': '',
				'data-copy-text': input.copyText,
				'data-copy-tooltip': input.tooltip,
				...(input.outdated ? { 'data-fork-outdated-copy': '' } : {}),
			}
		: {}
	const statusAttrs = input.status
		? { 'data-package-title-status': input.status }
		: {}
	const shared = {
		'data-testid': input.testId,
		'aria-label': input.label,
		'aria-describedby': tooltipId,
		...statusAttrs,
		...copyAttrs,
	}
	const children = (
		<>
			{renderIcon(input.icon, { size: actionIconSize })}
			<span>{input.label}</span>
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{feedback ?? input.tooltip}
			</span>
			<span role="status" css={visuallyHiddenCss}>
				{feedback ?? ''}
			</span>
		</>
	)
	const styles = input.primary
		? packageActionPrimaryCss
		: packageActionSecondaryCss
	if (input.href) {
		return (
			<SiteLink href={input.href} {...shared} css={styles} onClick={copy}>
				{children}
			</SiteLink>
		)
	}
	return (
		<button type="button" {...shared} css={styles} onClick={copy}>
			{children}
		</button>
	)
}

/**
 * The group sits at the right edge of the tab row on desktop, so tooltips
 * open leftward from the control's right edge. On mobile the group starts at
 * the left gutter, so they open rightward instead. Centered tooltips ran off
 * the viewport in both places.
 */
const edgeAnchoredTooltipCss = {
	'& [role="tooltip"]': {
		...copyPromptTooltipCss['& [role="tooltip"]'],
		left: 'auto',
		right: 0,
		transform: 'none',
		[mq.mobile]: {
			left: 0,
			right: 'auto',
		},
	},
	'& [role="tooltip"]::after': {
		...copyPromptTooltipCss['& [role="tooltip"]::after'],
		left: 'auto',
		right: '1rem',
		transform: 'none',
		[mq.mobile]: {
			left: '1rem',
			right: 'auto',
		},
	},
}

/**
 * Repo actions reuse the account-area pill vocabulary at tab-row height: one
 * filled pill for the action the page exists for, ghost pills for everything
 * else. Topic tags and status badges never use these.
 */
function compactActionCss<
	T extends ReturnType<typeof getPillButtonCss | typeof getGhostButtonCss>,
>(
	base: T,
	ink: {
		backgroundColor: string
		color: string
	},
) {
	return {
		...base,
		...copyPromptTooltipCss,
		...edgeAnchoredTooltipCss,
		position: 'relative' as const,
		padding: '0.5rem 0.95rem',
		font: `650 0.875rem/1 ${typography.fontFamilyDisplay}`,
		// Preserve action contrast after applying shared tooltip styles.
		backgroundColor: ink.backgroundColor,
		color: ink.color,
		'& > span:not([role="tooltip"])': {
			color: 'inherit',
		},
		'& > svg': {
			color: 'inherit',
		},
		'&:focus-visible': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: '2px',
		},
		[hoverMq]: {
			...base[hoverMq],
			...copyPromptTooltipCss[hoverMq],
		},
	}
}

const packageActionPrimaryCss = compactActionCss(
	getPillButtonCss({ size: 'sm' }),
	{ backgroundColor: colors.primary, color: colors.onPrimary },
)
const packageActionSecondaryCss = compactActionCss(
	getGhostButtonCss({ size: 'sm' }),
	{ backgroundColor: 'transparent', color: colors.text },
)

const spinnerCss = {
	...inlineSpinnerCss,
	display: 'inline-block',
	width: actionIconSize,
	height: actionIconSize,
	border: '1.5px solid oklch(from currentColor l c h / 0.35)',
	borderTopColor: 'currentColor',
	// `inline-block` would otherwise beat the `hidden` attribute in idle.
	'&[hidden]': {
		display: 'none',
	},
}

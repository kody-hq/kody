/** @jsxImportSource @emotion/react */
import { useMatches, useRouteContext } from '@tanstack/react-router'
import { type MatchedPageNavigation } from '../page-navigation.ts'
import { appShellForMatches } from '../app-shell.ts'
import { type CSSObject } from '@emotion/react'
import { type ReactNode, type FormEvent } from 'react'
import { organizationsWithSignupFallback } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import { useShellData } from '../routes/__root.tsx'
import { getSessionDisplayName, type SessionInfo } from '#client/session.ts'
import {
	accountRailGroups,
	accountRailOrgSlug,
	isAccountNavItemSelected,
	railTabsForSelection,
	workspaceRailGroups,
	type AccountRailGroup,
} from '#client/routes/account-rail.ts'
import { type IconName } from '../components/icon.tsx'
import {
	EntityExplainer,
	resolveEntityExplainer,
	type EntityExplainerId,
} from './entity-explainer.tsx'
import { AccountSectionTabs } from './account-section-tabs.tsx'
import {
	AccountManagementLinkNav,
	accountManagementNarrowMq,
} from './account-management-link-nav.tsx'

export {
	AccountManagementInlineLinkNav,
	accountManagementNarrowMq,
} from './account-management-link-nav.tsx'

/*
 * Account-area visual language, ported from the redesign prototype
 * (`landing/account.html` + the `.account-*` blocks in `landing/styles.css`).
 * Sections are hairline-divided (no card chrome), headings speak in the
 * display face, ledes are muted and measured, and nav links are quiet pills
 * that only go green when current.
 */

/** `.account-section` — hairline-topped section, no card chrome. */
const accountSectionCss: CSSObject = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: 'clamp(2rem, 4vw, 2.75rem)',
	scrollMarginTop: '5.5rem',
	display: 'grid',
	gap: spacing.md,
}

/** `.account-section h2` — display face, quiet weight. */
const accountSectionTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.35rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	color: colors.text,
	lineHeight: 1.2,
}

/** `.account-section > p` — muted lede with a reading measure. */
const accountSectionLedeCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '60ch',
	textWrap: 'balance' as const,
}

/** `.field` */
export const accountFieldCss: CSSObject = {
	display: 'grid',
	gap: '0.45rem',
	minWidth: 0,
}

/** `.field label` */
export const accountFieldLabelCss: CSSObject = {
	fontSize: '0.92rem',
	fontWeight: 600,
	color: colors.text,
}

/** `.field input` — the shared auth-field treatment (green border + glow on
 * focus). Inputs must carry `data-field-ring` so the unlayered global
 * `:focus-visible` outline stands down. */
export const accountInputCss: CSSObject = {
	...getAuthInputCss(),
	maxWidth: '100%',
}

export const accountTextareaCss: CSSObject = {
	...accountInputCss,
	resize: 'vertical' as const,
	minHeight: '7rem',
}

/** `.field-note` */
export const accountFieldNoteCss: CSSObject = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

/** `.verified` — the little green status pill next to the account email. */
export const verifiedPillCss: CSSObject = {
	display: 'inline-block',
	fontSize: '0.8rem',
	fontWeight: 600,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
	borderRadius: radius.full,
	padding: '0.1rem 0.55rem',
	marginLeft: '0.3rem',
}

/** `.account-actions` — wrapping row of small pill/ghost actions. */
export const accountActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

/** `.account-more` — quiet green disclosure ("Change email"). */
export const accountDisclosureCss: CSSObject = {
	'& > summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.primaryText,
		width: 'fit-content',
		minHeight: '44px',
		boxSizing: 'border-box' as const,
		paddingBlock: '0.55rem',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'& > summary:hover': { color: colors.text },
	},
	'&[open] > summary': { marginBottom: '0.4rem' },
	'& > :not(summary)': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
}

type AccountManagementSlot = ReactNode

type AccountManagementShellProps = {
	currentHref?: string
	/**
	 * Optional cap on the content column (not the whole grid). Useful for
	 * pages whose forms read better on a narrower measure.
	 */
	maxWidth?: string
	/**
	 * The route is refetching this location while its last good content stays
	 * on screen (`createRouteData` snapshot `pending` with data). Marks the
	 * shell `aria-busy` and announces it to assistive tech without moving
	 * layout. Leave unset on the cold path where the route shows its own
	 * loading copy.
	 */
	busy?: boolean
	children: AccountManagementSlot
}

/** Prototype `.account` section rhythm: margin between blocks in the content column. */
const accountSectionGap = 'clamp(2rem, 4vw, 2.75rem)'

export function AccountManagementShell(props: AccountManagementShellProps) {
	const shell = useMatches({ select: appShellForMatches })
	const hasNavigation = Boolean(props.currentHref && shell.mode !== 'focused')
	return (
		<section
			data-account-shell
			aria-busy={props.busy ? 'true' : undefined}
			css={{
				width: '100%',
				maxWidth: hasNavigation
					? layoutMaxWidths.extended
					: (props.maxWidth ?? layoutMaxWidths.extended),
				margin: '0 auto',
				flexGrow: 1,
				boxSizing: 'border-box',
				display: 'grid',
				alignContent: 'start',
				padding: `0 ${pageGutter} clamp(3rem, 7vw, 5rem)`,
				...(hasNavigation
					? {
							gridTemplateColumns: '200px minmax(0, 1fr)',
							columnGap: 'clamp(2rem, 5vw, 4.5rem)',
						}
					: {}),
				[accountManagementNarrowMq]: { gridTemplateColumns: 'minmax(0, 1fr)' },
			}}
		>
			{hasNavigation && props.currentHref ? <ShellNavigation /> : null}
			<div
				data-account-content
				css={{
					minWidth: 0,
					paddingTop: 'clamp(2rem, 5vw, 3.5rem)',
					display: 'grid',
					alignContent: 'start',
					alignItems: 'start',
					gap: hasNavigation ? accountSectionGap : spacing.xl,
					...(props.maxWidth ? { '& > *': { maxWidth: props.maxWidth } } : {}),
					[accountManagementNarrowMq]: {
						gap: spacing.xl,
						paddingTop: hasNavigation ? spacing.xl : 'clamp(2rem, 5vw, 3.5rem)',
					},
				}}
			>
				{props.busy ? (
					<p
						role="status"
						css={{
							position: 'absolute',
							width: 1,
							height: 1,
							overflow: 'hidden',
						}}
					>
						Loading…
					</p>
				) : null}
				{props.children}
			</div>
		</section>
	)
}

function ShellNavigation() {
	const session = useShellData().session
	const { pageNavigation } = useRouteContext({ strict: false })
	const admin = pageNavigation?.rail === 'admin'
	const rail = pageRail({ session, navigation: pageNavigation })
	return (
		<div
			data-account-navigation
			css={{
				minWidth: 0,
				[accountManagementNarrowMq]: { paddingTop: 'clamp(2rem, 5vw, 3.5rem)' },
			}}
		>
			<AccountManagementLinkNav
				workspaceSwitcher={admin ? undefined : rail.workspaceSwitcher}
				label={admin ? 'Admin sections' : rail.label}
				heading={admin ? undefined : rail.heading}
				groups={
					admin
						? [
								{
									label: null,
									items: adminNavItems.map((item) => ({
										href: item.href,
										label: item.label,
										icon: item.icon,
										active: item.id === pageNavigation?.item,
									})),
								},
							]
						: railLinkGroups(rail.groups, pageNavigation?.item)
				}
			/>
		</div>
	)
}

type AccountManagementHeaderProps = {
	/** Context above the H1, such as the package a decision is about. */
	eyebrow?: AccountManagementSlot
	title: string
	description: string
	actions?: AccountManagementSlot
	titleAside?: AccountManagementSlot
}

export function AccountManagementHeader(props: AccountManagementHeaderProps) {
	return (
		<header
			css={{
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'flex-start',
				gap: spacing.md,
				flexWrap: 'wrap',
			}}
		>
			<div css={{ display: 'grid', gap: '0.6rem', minWidth: 0 }}>
				{props.eyebrow ?? null}
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: '0.15rem',
						minWidth: 0,
					}}
				>
					<h1
						css={{
							fontSize: 'clamp(2rem, 4vw, 2.7rem)',
							fontWeight: 760,
							letterSpacing: '-0.026em',
							lineHeight: 1.08,
							color: colors.text,
							margin: 0,
						}}
					>
						{props.title}
					</h1>
					{props.titleAside ?? null}
				</div>
				<p css={{ color: colors.textMuted, margin: 0 }}>{props.description}</p>
			</div>
			{props.actions ? (
				<div
					css={{
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
					}}
				>
					{props.actions}
				</div>
			) : null}
		</header>
	)
}

const adminNavItems = [
	{
		href: '/admin/users',
		label: 'Users',
		icon: 'users',
		id: 'users',
	},
	{
		href: '/admin/insights',
		label: 'Insights',
		icon: 'pie-chart',
		id: 'insights',
	},
	{
		href: '/admin/reserved-usernames',
		label: 'Reserved usernames',
		icon: 'user-cross',
		id: 'reserved-usernames',
	},
	{
		href: '/admin/feature-flags',
		label: 'Feature flags',
		icon: 'flag',
		id: 'feature-flags',
	},
	{
		href: '/admin/platform-integrations',
		label: 'Platform integrations',
		icon: 'globe',
		id: 'platform-integrations',
	},
	{
		href: '/admin/provider-marks',
		label: 'Provider marks',
		icon: 'photo',
		id: 'provider-marks',
	},
	{
		href: '/admin/codemods',
		label: 'Codemods',
		icon: 'code',
		id: 'codemods',
	},
	{
		href: '/admin/roles',
		label: 'Roles',
		icon: 'shield',
		id: 'roles',
	},
	{
		href: '/admin/community-reports',
		label: 'Community reports',
		icon: 'warning-triangle',
		id: 'community-reports',
	},
	{
		href: routes.adminPlatformFeedback.href(),
		label: 'Platform feedback',
		icon: 'message',
		id: 'platform-feedback',
	},
	{
		href: '/admin/system-email',
		label: 'System email',
		icon: 'inbox',
		id: 'system-email',
	},
] as const satisfies ReadonlyArray<{
	href: string
	label: string
	icon: IconName
	id: string
}>

type AccountPageHeaderProps = {
	entity?: EntityExplainerId
	title: string
	description: string
	currentHref: string
	actions?: AccountManagementSlot
}

function railLinkGroups(
	groups: Array<AccountRailGroup>,
	itemId: string | undefined,
) {
	return groups.map((group) => ({
		label: group.label,
		note: group.note,
		items: group.items.map((item) => ({
			href: item.href,
			label: item.label,
			icon: item.icon,
			active: isAccountNavItemSelected(item, itemId),
		})),
	}))
}

function pageRail(input: {
	session: SessionInfo | null
	navigation: MatchedPageNavigation | undefined
}) {
	const organizations = input.session?.organizations ?? []
	if (input.navigation?.rail !== 'workspace') {
		return {
			label: 'Account sections',
			heading: { eyebrow: 'Account' },
			workspaceSwitcher: undefined,
			groups: accountRailGroups(),
		}
	}
	const orgSlug = accountRailOrgSlug({
		orgSlug:
			input.navigation.orgSlug ??
			(organizations.some((org) => org.slug === input.navigation?.profileSlug)
				? (input.navigation.profileSlug ?? null)
				: null),
		organizations,
		username: input.session?.username,
	})
	// No slug yet means `/account/...` fallbacks, which redirect to the
	// signup organization.
	const org = organizations.find((entry) => entry.slug === orgSlug)
	const personal =
		orgSlug === null || (org?.personal ?? orgSlug === input.session?.username)
	// Prefer the session role when the org is listed. Collaborators keep
	// `null`. When the list is stale on a team URL, use member-shaped links
	// (Settings/Members/Teams/Grants/Collaborators, no Billing) so chrome
	// stays on the URL org without inventing Owner-only Billing.
	const role =
		org !== undefined
			? org.role
			: personal
				? ('owner' as const)
				: orgSlug !== null
					? ('member' as const)
					: null
	const session = input.session
	return {
		label: 'Workspace sections',
		heading: {
			eyebrow: 'Workspace',
			name: orgSlug ? `@${orgSlug}` : undefined,
		},
		workspaceSwitcher:
			session && orgSlug
				? {
						currentSlug: orgSlug,
						organizations: organizationsWithSignupFallback({
							organizations,
							username: session.username,
						}),
						inviteCount: session.inviteCount ?? 0,
						username: session.username,
						displayName: getSessionDisplayName(session),
						avatarUrl: session.avatarUrl,
						switchTarget: input.navigation?.workspaceSwitch,
					}
				: undefined,
		groups: workspaceRailGroups({
			orgSlug,
			personal,
			role,
		}),
	}
}

/**
 * Section rail plus the page title. Person settings (profile, security,
 * organizations) take the account rail; everything an organization owns
 * takes the workspace rail, headed by the organization it belongs to. The
 * desktop rail occupies its own grid column and sets the shell height from
 * the first server-rendered frame. The phone menu is in normal flow and comes first, above the
 * H1. An entity explainer, when this page has one, is the info button
 * beside the H1.
 */
export function AccountPageHeader(props: AccountPageHeaderProps) {
	{
		const session = useShellData().session
		const explainer = resolveEntityExplainer(props.entity)
		const { pageNavigation } = useRouteContext({ strict: false })
		const rail = pageRail({ session, navigation: pageNavigation })
		const tabs = railTabsForSelection(rail.groups, pageNavigation?.item)

		return (
			<>
				<AccountManagementHeader
					title={props.title}
					description={props.description}
					actions={props.actions}
					titleAside={explainer ? <EntityExplainer copy={explainer} /> : null}
				/>
				{tabs ? (
					<AccountSectionTabs label={tabs.label} tabs={tabs.tabs} />
				) : null}
			</>
		)
	}
}

type AdminPageHeaderProps = {
	title: string
	description: string
	currentHref: string
}

export function AdminPageHeader(props: AdminPageHeaderProps) {
	return (
		<AccountManagementHeader
			title={props.title}
			description={props.description}
		/>
	)
}

type AccountManagementMessageProps = {
	children: AccountManagementSlot
	tone?: 'info' | 'error'
}

export function AccountManagementMessage(props: AccountManagementMessageProps) {
	return (
		<p
			role={props.tone === 'error' ? 'alert' : 'status'}
			aria-live={props.tone === 'error' ? 'assertive' : 'polite'}
			css={{
				color: props.tone === 'error' ? colors.error : colors.text,
				margin: 0,
			}}
		>
			{props.children}
		</p>
	)
}

type AccountManagementPanelProps = {
	id?: string
	title?: string
	description?: string
	children?: AccountManagementSlot
	asForm?: boolean
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void
	ariaLabel?: string
}

export function AccountManagementPanel(props: AccountManagementPanelProps) {
	const content = () => (
		<>
			{props.title || props.description ? (
				<div css={{ display: 'grid', gap: '0.6rem' }}>
					{props.title ? (
						<h2 css={accountSectionTitleCss}>{props.title}</h2>
					) : null}
					{props.description ? (
						<p css={accountSectionLedeCss}>{props.description}</p>
					) : null}
				</div>
			) : null}
			{props.children}
		</>
	)

	return props.asForm ? (
		<form
			id={props.id}
			method="post"
			noValidate
			css={accountSectionCss}
			onSubmit={props.onSubmit}
		>
			{content()}
		</form>
	) : (
		<section id={props.id} aria-label={props.ariaLabel} css={accountSectionCss}>
			{content()}
		</section>
	)
}

type MetadataGridProps = {
	items: Array<{
		/** Defaults to `label`; pass one when two rows can share a label. */
		key?: string
		label: string
		value: AccountManagementSlot
	}>
}

export function MetadataGrid(props: MetadataGridProps) {
	return (
		<dl
			css={{
				display: 'grid',
				// Columns come from the room available rather than a per-page
				// count. A declared `columns={3}` divided the 376px detail pane
				// into 115px columns, which is a third of a UUID. The 14rem floor
				// is what an id needs at the `IdValue` size; below two of those
				// the band is a single column on its own, at every viewport,
				// without a breakpoint having to guess the container's width.
				// The `min()` keeps the floor from overflowing a container
				// narrower than the floor itself.
				gridTemplateColumns: 'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
				gap: spacing.md,
				margin: 0,
			}}
		>
			{props.items.map((item) => (
				<div key={item.key ?? item.label} css={{ minWidth: 0 }}>
					<dt css={accountFieldLabelCss}>{item.label}</dt>
					<dd
						css={{
							margin: 0,
							color: colors.text,
							minWidth: 0,
							overflowWrap: 'anywhere',
						}}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	)
}

/**
 * An identifier is a copy target, not a sentence. The value stays on one line
 * and clips, so a 36-character UUID can no longer break a metadata column into
 * five lines of hex.
 *
 * The whole string stays in the DOM — clipping is CSS, never a truncated
 * substring — so a screen reader still reads the id in full, and `user-select:
 * all` turns one click into a whole-value selection for anyone the clipboard
 * button does not work for. `title` is the mouse-hover convenience on top of
 * that, not the mechanism.
 */
export function IdValue(props: {
	value: string
	/** Field name, so the copy button says which id it takes. */
	label: string
}) {
	return (
		<span
			css={{
				display: 'flex',
				alignItems: 'center',
				gap: '0.35rem',
				minWidth: 0,
			}}
		>
			<code
				title={props.value}
				css={{
					minWidth: 0,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					userSelect: 'all',
					fontFamily: 'monospace',
					fontSize: typography.fontSize.sm,
					padding: '0.2rem 0.42rem',
					borderRadius: radius.sm,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.background,
					color: colors.text,
				}}
			>
				{props.value}
			</code>
			<CopyTextButton
				value={props.value}
				variant="chip"
				ariaLabel={`Copy ${props.label}`}
			/>
		</span>
	)
}

/**
 * A timestamp in a metadata cell reads as one token: a locale string breaking
 * after its comma looks like two values, and tabular figures keep a column of
 * them from shifting sideways as the digits change.
 */
export function TimestampValue(props: {
	value: string | null
	fallback?: string
}) {
	return (
		<span
			css={{
				whiteSpace: 'nowrap',
				fontVariantNumeric: 'tabular-nums',
			}}
		>
			{formatNullableTimestamp(props.value, props.fallback ?? '—')}
		</span>
	)
}

/**
 * Quiet surface callout, matching the prototype's `.onboard-callout` chrome.
 * The redesign never uses green as a background wash — emphasis lives in the
 * callout's copy and action, not its border.
 */
export const noticeCardCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

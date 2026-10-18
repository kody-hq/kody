/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect, useRef } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { renderIcon, type IconName } from '../components/icon.tsx'
import { colors, transitions } from '#universal/styles/tokens.ts'
import {
	hoverMq,
	siteHeaderHeight,
} from '#universal/styles/style-primitives.ts'
import { dismissOpenPopoverPanel } from '../components/switcher-menu.tsx'
import {
	WorkspaceSwitcher,
	workspaceSwitcherPanelId,
	type WorkspaceSwitcherData,
} from '../components/workspace-switcher.tsx'

/** Account nav collapses to a wrapping row below this width (prototype 860px). */
export const accountManagementNarrowMq = '@media (max-width: 860px)'

type AccountManagementLinkNavItem = {
	href: string
	label: string
	active: boolean
	icon?: IconName
}

type AccountManagementLinkNavGroup = {
	note?: string
	label: string | null
	items: Array<AccountManagementLinkNavItem>
}

type AccountManagementLinkNavProps = {
	label: string
	/** Names whose settings these are: "Account", or "Workspace" plus `@slug`. */
	heading?: { eyebrow: string; name?: string }
	/** Draws the heading as the organization switcher (workspace rails). */
	workspaceSwitcher?: WorkspaceSwitcherData
	groups: Array<AccountManagementLinkNavGroup>
}

type AccountManagementInlineLinkNavProps = {
	label: string
	items: Array<AccountManagementLinkNavItem>
}

const railHeadingCss = {
	display: 'grid',
	gap: '0.1rem',
	padding: '0 0.7rem 0.6rem',
	margin: 0,
	minWidth: 0,
}

const railEyebrowCss = {
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const railNameCss = {
	fontWeight: 650,
	fontSize: '0.98rem',
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const railGroupLabelCss = {
	margin: 0,
	padding: '0.85rem 0.7rem 0.3rem',
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const railGroupCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.15rem',
}

function renderRailHeading(heading: AccountManagementLinkNavProps['heading']) {
	if (!heading) return null
	return (
		<p css={railHeadingCss} data-account-nav-heading>
			<span css={railEyebrowCss}>{heading.eyebrow}</span>
			{heading.name ? <span css={railNameCss}>{heading.name}</span> : null}
		</p>
	)
}

function renderRailGroups(
	groups: Array<AccountManagementLinkNavGroup>,
	linkCss: CSSObject,
) {
	return groups.map((group, index) => (
		<div
			key={group.label ?? `group-${index}`}
			role={group.label ? 'group' : undefined}
			aria-label={group.label ?? undefined}
			css={railGroupCss}
		>
			{group.label ? (
				<p aria-hidden="true" css={railGroupLabelCss}>
					{group.label}
				</p>
			) : null}
			{group.note ? (
				<p
					css={{
						margin: 0,
						padding: '0.35rem 0.7rem 0.55rem',
						fontSize: '0.8rem',
						lineHeight: 1.4,
						color: colors.textMuted,
					}}
					data-testid="account-rail-group-note"
				>
					{group.note}
				</p>
			) : null}
			{renderAccountNavLinks(group.items, linkCss)}
		</div>
	))
}

/** `.account-nav a` — quiet link pills; only the current one goes green. */
const accountNavLinkCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
	padding: '0.5rem 0.7rem',
	borderRadius: '10px',
	color: colors.textMuted,
	fontWeight: 550,
	fontSize: '0.98rem',
	textDecoration: 'none',
	transition: `color ${transitions.fast}, background-color ${transitions.fast}`,
	'& [data-icon]': {
		flex: 'none',
	},
	[hoverMq]: {
		'&:hover': { color: colors.text, backgroundColor: colors.surface },
	},
	'&[aria-current]': {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
}

const accountMobileNavLinkCss: CSSObject = {
	...accountNavLinkCss,
	display: 'flex',
	alignItems: 'center',
	minHeight: '44px',
	padding: '0.55rem 0.75rem',
	borderRadius: '0.45rem',
}

const accountMobileMenuCss: CSSObject = {
	display: 'none',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	background: colors.surface,
	'& > summary': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.6rem',
		minHeight: '44px',
		padding: '0.7rem 1rem',
		cursor: 'pointer',
		fontWeight: 650,
		color: colors.text,
		listStyle: 'none',
	},
	'& > summary::-webkit-details-marker': { display: 'none' },
	'& > summary::marker': { content: '""' },
	'& > summary [data-icon]': {
		flex: 'none',
		color: colors.textMuted,
	},
	'& > nav': {
		display: 'grid',
		gap: '0.15rem',
		padding: '0.4rem 0.6rem 0.7rem',
		borderTop: `1px solid ${colors.border}`,
	},
	[accountManagementNarrowMq]: {
		display: 'block',
	},
}

const accountMobileMenuCurrentCss: CSSObject = {
	color: colors.textMuted,
	fontWeight: 500,
	fontSize: '0.9rem',
}

function renderAccountNavLinks(
	items: Array<AccountManagementLinkNavItem>,
	linkCss: CSSObject,
) {
	return items.map((item) => (
		<SiteLink
			key={item.href}
			href={item.href}
			aria-current={item.active ? 'page' : undefined}
			css={linkCss}
		>
			{item.icon ? renderIcon(item.icon, { size: '1.05em' }) : null}
			{item.label}
		</SiteLink>
	))
}

export function AccountManagementLinkNav(props: AccountManagementLinkNavProps) {
	const mobileMenu = useRef<HTMLDetailsElement>(null)

	const href = useMatchedPageScope().pageLocation.href
	useEffect(() => {
		if (mobileMenu.current) mobileMenu.current.open = false
	}, [href])
	{
		const current = props.groups
			.flatMap((group) => group.items)
			.find((item) => item.active)
		return (
			<>
				<nav
					aria-label={props.label}
					data-account-nav
					css={{
						// Normal flow reserves the full rail height in server-rendered HTML.
						height: '100%',
						width: '200px',
						viewTransitionName: 'account-nav',
						[accountManagementNarrowMq]: {
							display: 'none',
						},
					}}
				>
					<div
						css={{
							// Sticks under the site header on a long page. `top`
							// matches `siteHeaderHeight` so at scrollY=0 the
							// natural position equals the sticky offset — a short
							// content column (filtered list) must not drop the
							// rail a few px higher than a tall one.
							position: 'sticky',
							top: siteHeaderHeight,
							display: 'flex',
							flexDirection: 'column',
							gap: '0.15rem',
						}}
					>
						{props.workspaceSwitcher ? (
							<WorkspaceSwitcher
								{...props.workspaceSwitcher}
								placement="rail"
							/>
						) : (
							renderRailHeading(props.heading)
						)}
						{renderRailGroups(props.groups, accountNavLinkCss)}
					</div>
				</nav>
				<details
					css={accountMobileMenuCss}
					ref={mobileMenu}
					onToggle={(event) => {
						if (!event.currentTarget.open)
							dismissOpenPopoverPanel(
								document.getElementById(workspaceSwitcherPanelId('drawer')),
							)
					}}
				>
					<summary>
						{renderIcon('menu', { size: '1.05em' })}
						<span>
							{props.heading?.name ?? props.heading?.eyebrow ?? props.label}
						</span>
						{current ? (
							<span css={accountMobileMenuCurrentCss}>{current.label}</span>
						) : null}
					</summary>
					<nav aria-label={props.label}>
						{props.workspaceSwitcher ? (
							<WorkspaceSwitcher
								{...props.workspaceSwitcher}
								placement="drawer"
							/>
						) : null}
						{renderRailGroups(props.groups, accountMobileNavLinkCss)}
					</nav>
				</details>
			</>
		)
	}
}

/**
 * In-flow pill row for filters and other secondary link sets. Do not use
 * `AccountManagementLinkNav` for this — that component is the unique
 * `[data-account-nav]` rail rendered in the shell navigation column.
 */
export function AccountManagementInlineLinkNav(
	props: AccountManagementInlineLinkNavProps,
) {
	return (
		<nav
			aria-label={props.label}
			css={{
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				gap: '0.3rem',
			}}
		>
			{props.items.map((item) => (
				<SiteLink
					key={item.href}
					href={item.href}
					aria-current={item.active ? 'page' : undefined}
					css={accountMobileNavLinkCss}
				>
					{item.label}
				</SiteLink>
			))}
		</nav>
	)
}

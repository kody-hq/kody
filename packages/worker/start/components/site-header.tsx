/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { dismissOpenPopoverPanel } from '#client/popover-open.ts'
import { type CSSObject } from '@emotion/react'
import { FeaturesMenu } from './features-menu.tsx'
import { SiteLink } from './site-link.tsx'
import { useEffect, useState } from 'react'
import {
	PhoneAccountGroups,
	AccountMenu,
	type OrganizationSession,
} from './org-switcher.tsx'
import {
	colors,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
	siteHeaderBrandMinHeight,
	siteHeaderNavPaddingBlock,
} from '#universal/styles/style-primitives.ts'

export type SiteHeaderProps = {
	focused?: boolean
	loggedIn: boolean
	organizationSession: OrganizationSession | null
	displayName: string
	username: string
	avatarUrl: string | null
	showAdminLink: boolean
	showDemoIndicator: boolean
	loginHref: string
	currentPathname: string
}

/**
 * Sticky site header from the 2026 landing redesign: brand, marketing nav
 * (Features · Community · Docs · Pricing · Blog), and the organization and account menu. The bottom hairline is a static CSS border so
 * it paints before JS.
 */
const marketingLinks = [
	{ href: '/community', label: 'Community' },
	{ href: '/docs', label: 'Docs' },
	{ href: '/pricing', label: 'Pricing' },
	{ href: '/blog', label: 'Blog' },
] as const

/**
 * `aria-current="page"` for a nav link: exact match, or a subpath of the
 * link's section (`/blog/why` marks Blog).
 */
function ariaCurrent(currentPathname: string, href: string) {
	return currentPathname === href || currentPathname.startsWith(`${href}/`)
		? ('page' as const)
		: undefined
}

/** One id: the invoker points at the panel with `popovertarget`. */
const menuPanelId = 'site-menu'

export function SiteHeader(props: SiteHeaderProps) {
	const [menuOpen, setMenuOpen] = useState(false)
	useEffect(() => {
		dismissOpenPopoverPanel(document.getElementById(menuPanelId))
	}, [props.currentPathname])
	function onMenuToggle(event: { newState?: string }) {
		setMenuOpen(event.newState === 'open')
	}

	if (props.focused)
		return (
			<header className="site-header" data-focused-header css={headerCss}>
				<div css={navCss}>
					<SiteLink href="/" css={brandCss}>
						<img
							src={publicAsset('/images/kody-mark.png')}
							alt=""
							width={34}
							height={34}
						/>
						<span>Kody</span>
					</SiteLink>
					<div css={{ marginLeft: 'auto', display: 'flex' }}>
						{props.loggedIn ? (
							<AccountMenu
								username={props.username}
								displayName={props.displayName}
								avatarUrl={props.avatarUrl}
								organizations={props.organizationSession?.organizations ?? []}
							/>
						) : (
							<SiteLink href={props.loginHref} css={navLoginCss}>
								Log in
							</SiteLink>
						)}
					</div>
				</div>
			</header>
		)

	return (
		<header className="site-header" css={headerCss}>
			<nav aria-label="Main" css={navCss}>
				<SiteLink href="/" css={brandCss}>
					<img
						src={publicAsset('/images/kody-mark.png')}
						alt=""
						width={34}
						height={34}
					/>
					<span>Kody</span>
				</SiteLink>
				<div css={navLinksCss}>
					<FeaturesMenu currentPathname={props.currentPathname} />
					{marketingLinks.map((link) => (
						<SiteLink
							key={link.href}
							href={link.href}
							aria-current={ariaCurrent(props.currentPathname, link.href)}
						>
							{link.label}
						</SiteLink>
					))}
					{props.showAdminLink ? (
						<SiteLink
							href="/admin/users"
							aria-current={ariaCurrent(props.currentPathname, '/admin/users')}
						>
							Admin
						</SiteLink>
					) : null}
				</div>
				<div css={navActionsCss}>
					{props.loggedIn ? (
						<>
							<AccountMenu
								organizations={props.organizationSession?.organizations ?? []}
								username={props.username}
								displayName={props.displayName}
								avatarUrl={props.avatarUrl}
							/>
							{props.showDemoIndicator ? (
								<span data-testid="demo-indicator" css={demoIndicatorCss}>
									Demo
								</span>
							) : null}
						</>
					) : (
						<SiteLink href={props.loginHref} css={navLoginCss}>
							Log in
						</SiteLink>
					)}
				</div>
				<button
					type="button"
					popoverTarget={menuPanelId}
					aria-label="Menu"
					aria-expanded={menuOpen ? 'true' : 'false'}
					data-open={menuOpen ? '' : undefined}
					css={menuToggleCss}
				>
					<span aria-hidden="true" css={burgerCss}>
						<span />
						<span />
						<span />
					</span>
				</button>
				<div
					id={menuPanelId}
					popover="auto"
					css={menuPanelCss}
					onToggle={(event) => onMenuToggle(event.nativeEvent)}
				>
					<div css={menuGroupCss}>
						<FeaturesMenu currentPathname={props.currentPathname} mobile />
						{marketingLinks.map((link) => (
							<SiteLink
								key={link.href}
								href={link.href}
								aria-current={ariaCurrent(props.currentPathname, link.href)}
							>
								{link.label}
							</SiteLink>
						))}
						{props.showAdminLink ? (
							<SiteLink
								href="/admin/users"
								aria-current={ariaCurrent(
									props.currentPathname,
									'/admin/users',
								)}
							>
								Admin
							</SiteLink>
						) : null}
					</div>
					{props.organizationSession ? (
						<PhoneAccountGroups
							session={props.organizationSession}
							currentPathname={props.currentPathname}
						/>
					) : (
						<div css={menuGroupCss}>
							<SiteLink href={props.loginHref}>Log in</SiteLink>
						</div>
					)}
				</div>
			</nav>
		</header>
	)
}

const headerCss: CSSObject = {
	position: 'sticky' as const,
	top: 0,
	zIndex: 10,
	viewTransitionName: 'site-header',
	background: `oklch(from ${colors.background} l c h / 0.85)`,
	'@supports (backdrop-filter: blur(1px))': {
		backdropFilter: 'blur(14px)',
	},
}

const navCss: CSSObject = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `${siteHeaderNavPaddingBlock} ${pageGutter}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.8rem',
	flexWrap: 'wrap' as const,
	'@media (min-width: 821px) and (max-width: 1000px)': { gap: '0.8rem' },
}

const brandCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	minHeight: siteHeaderBrandMinHeight,
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

/**
 * Below this the inline nav and session corner would crowd the brand, so both
 * fold into the menu panel. Wider than the mobile token: it is the width the
 * links themselves stop fitting, not a device class.
 */
const headerNavMq = '@media (max-width: 820px)'

const navLinksCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	'@media (min-width: 821px) and (max-width: 1000px)': { gap: '0.8rem' },
	gap: '1.6rem',
	marginRight: 'auto',
	'& > a': {
		color: colors.textMuted,
		textDecoration: 'none',
		fontWeight: 500,
		fontSize: '0.98rem',
		transition: `color ${transitions.fast}`,
	},
	'& > a:hover': { color: colors.text },
	'& > a[aria-current="page"]': { color: colors.text },
	[headerNavMq]: { display: 'none' },
}

const navActionsCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	// The links are gone at this width, so the actions take the free space
	// and keep the toggle pinned to the right edge.
	[headerNavMq]: { display: 'none' },
}

const menuToggleCss: CSSObject = {
	display: 'none',
	marginLeft: 'auto',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	padding: 0,
	borderRadius: '12px',
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}, scale ${transitions.fast}`,
	'&:active': { scale: '0.94' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { scale: 'none' },
	},
	[headerNavMq]: { display: 'inline-flex' },
}

/** Three rules that fold into a cross. Transform-only, so it stays composited. */
const burgerCss: CSSObject = {
	display: 'grid',
	gap: '4px',
	width: '18px',
	'& > span': {
		display: 'block',
		height: '2px',
		borderRadius: '2px',
		backgroundColor: 'currentColor',
		transition: `translate 180ms ${transitions.easeOut}, rotate 180ms ${transitions.easeOut}, opacity 120ms ${transitions.easeOut}, scale 120ms ${transitions.easeOut}`,
	},
	// The end state still changes under reduced motion , only the tweening goes.
	'@media (prefers-reduced-motion: reduce)': {
		'& > span': { transition: 'none' },
	},
	'[data-open] &> span:nth-of-type(1)': { translate: '0 6px', rotate: '45deg' },
	'[data-open] &> span:nth-of-type(2)': { opacity: 0, scale: '0.4' },
	'[data-open] &> span:nth-of-type(3)': {
		translate: '0 -6px',
		rotate: '-45deg',
	},
}

/**
 * The menu is a native popover: the top layer, light dismiss, Escape, and
 * focus return all come from the platform, and the entrance is a plain
 * transition thanks to `@starting-style` plus discrete `display`/`overlay`.
 * 180ms, the dropdown budget , this opens often enough that it must not
 * make anyone wait.
 */
const menuPanelCss: CSSObject = {
	position: 'fixed' as const,
	inset: 'auto' as const,
	top: '4.15rem',
	left: pageGutter,
	right: pageGutter,
	width: 'auto',
	maxWidth: 'none',
	maxHeight: 'calc(100dvh - 5.5rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '0.5rem',
	// No base `display`: a closed popover must keep the UA's `display: none`,
	// or the invisible fixed panel keeps swallowing taps where the menu was.
	// The `display … allow-discrete` transition holds `grid` through the exit.
	gap: '0.35rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: '18px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	opacity: 0,
	translate: '0 -8px',
	scale: '0.98',
	transformOrigin: 'top center',
	transition: `opacity 180ms ${transitions.easeOut}, translate 180ms ${transitions.easeOut}, scale 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	'&:popover-open': {
		display: 'grid',
		opacity: 1,
		translate: '0 0',
		scale: '1',
		'@starting-style': {
			opacity: 0,
			translate: '0 -8px',
			scale: '0.98',
		},
	},
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.4)',
		opacity: 0,
		transition: `opacity 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	},
	'&:popover-open::backdrop': {
		opacity: 1,
		'@starting-style': { opacity: 0 },
	},
	'@media (prefers-reduced-motion: reduce)': {
		translate: 'none',
		scale: 'none',
		transition: `opacity 120ms ${transitions.easeOut}, display 120ms allow-discrete, overlay 120ms allow-discrete`,
	},
	// Desktop never sees it; the inline nav is the menu there. `:popover-open`
	// is repeated so this outranks the open state's `display: grid`.
	'@media (min-width: 821px)': {
		display: 'none',
		'&:popover-open': { display: 'none' },
	},
}

const menuGroupCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	'& + &': {
		marginTop: '0.35rem',
		paddingTop: '0.5rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& > a': {
		display: 'flex',
		alignItems: 'center',
		// Comfortable target on a phone, not a cramped text link.
		minHeight: '44px',
		padding: '0 0.85rem',
		borderRadius: '12px',
		color: colors.text,
		textDecoration: 'none',
		fontWeight: 550,
		fontSize: '1rem',
		transition: `background-color ${transitions.fast}, color ${transitions.fast}`,
	},
	'& > a[aria-current="page"]': {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
	'& > a:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'& > a:hover': { backgroundColor: colors.primarySoftest },
	},
}

const navLoginCss: CSSObject = {
	fontWeight: 550,
	fontSize: '0.98rem',
	color: colors.text,
	textDecoration: 'none',
	padding: '0.7rem 0.25rem',
	whiteSpace: 'nowrap' as const,
	'&:hover': { color: colors.primaryText },
}

const demoIndicatorCss: CSSObject = {
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.375rem',
	padding: `0 ${spacing.xs}`,
	lineHeight: 1.6,
	letterSpacing: '0.02em',
	textTransform: 'uppercase' as const,
}

/** @jsxImportSource @emotion/react */
import { dismissOpenPopoverPanel, isPopoverOpen } from '#client/popover-open.ts'
import {
	useState,
	useEffect,
	type ReactNode,
	type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useLoaderData, useLocation } from '@tanstack/react-router'
import { workspaceHomeHref } from '#client/routes/account-rail.ts'
import { SiteLink } from './site-link.tsx'
import { type IconName, renderIcon } from './icon.tsx'
import { UserAvatar } from './user-avatar.tsx'
import {
	urlOrgSlug,
	orderOrganizations,
	orgOverviewPath,
	orgRoleManagesBilling,
	orgSlugFromOrgOwnedPath,
	orgSlugFromPathname,
	orgUsagePath,
	organizationsWithSignupFallback,
	type OrganizationSummary,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { signOut } from '#start/server/security-mutations'
import {
	colors,
	radius,
	shadows,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
const headerNavMq = '@media (max-width: 820px)'
type SwitcherRow = {
	key: string
	href: string
	label: string
	detail: string | null
	ariaCurrent: 'true' | 'page' | undefined
	/** The organization the header is acting in; drawn with a check. */
	selected: boolean
	leading: ReactNode
	badge: string | null
}

function renderSwitcherRow(row: SwitcherRow) {
	return (
		<SiteLink
			key={row.key}
			href={row.href}
			aria-current={row.ariaCurrent}
			data-testid={`org-switcher-${row.key}`}
			data-selected={row.selected ? '' : undefined}
			css={switcherRowCss}
		>
			<span css={switcherLeadingCss}>{row.leading}</span>
			<span css={switcherRowTextCss}>
				<span css={switcherRowLabelCss}>{row.label}</span>
				{row.detail ? (
					<span css={switcherRowDetailCss}>{row.detail}</span>
				) : null}
			</span>
			{row.badge ? <span css={switcherCountCss}>{row.badge}</span> : null}
			{row.selected ? (
				<span css={switcherCheckCss}>
					{renderIcon('check', { size: '1.1rem' })}
				</span>
			) : null}
		</SiteLink>
	)
}

function renderIconWell(name: IconName) {
	return (
		<span aria-hidden="true" css={switcherIconWellCss}>
			{renderIcon(name, { size: '1rem' })}
		</span>
	)
}

function LogoutRow() {
	const queryClient = useQueryClient()
	const mutation = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			await queryClient.cancelQueries()
			queryClient.clear()
			window.location.assign('/login')
		},
	})
	return (
		<form
			key="logout"
			method="post"
			onSubmit={(event) => {
				event.preventDefault()
				mutation.mutate()
			}}
			css={{ margin: 0, display: 'grid' }}
		>
			<button
				type="submit"
				disabled={mutation.isPending}
				data-testid="org-switcher-logout"
				css={switcherButtonRowCss}
			>
				<span css={switcherLeadingCss}>{renderIconWell('lock')}</span>
				<span css={switcherRowTextCss}>
					<span css={switcherRowLabelCss}>Log out</span>
				</span>
			</button>
			{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
		</form>
	)
}

/** Focus order for the arrow keys: the trigger, then every row in the panel. */
function moveSwitcherFocus(
	event: ReactKeyboardEvent,
	panel: HTMLElement | null,
) {
	if (!panel || !isPopoverOpen(panel)) return
	const rows = Array.from(
		panel.querySelectorAll<HTMLElement>('a[href], button'),
	)
	if (rows.length === 0) return
	const index = rows.findIndex((row) => row === document.activeElement)
	const next =
		event.key === 'ArrowDown'
			? rows[(index + 1) % rows.length]
			: event.key === 'ArrowUp'
				? rows[index <= 0 ? rows.length - 1 : index - 1]
				: event.key === 'Home'
					? rows[0]
					: event.key === 'End'
						? rows[rows.length - 1]
						: null
	if (!next) return
	event.preventDefault()
	next.focus()
}

export type OrganizationSession = {
	organizations: Array<OrganizationSummary>
	inviteCount: number
	username: string
}
export function PhoneAccountGroups(props: {
	session: OrganizationSession
	currentPathname: string
}) {
	const organizations = organizationsWithSignupFallback({
		organizations: props.session.organizations,
		username: props.session.username,
	})
	return (
		<div data-testid="site-menu-account">
			{renderManageGroup({
				links: accountMenuManageLinks({
					pathname: props.currentPathname,
					organizations,
				}),
				currentPathname: props.currentPathname,
				divided: false,
			})}
			{renderAccountGroup({
				username: props.session.username,
				currentPathname: props.currentPathname,
				organizations,
				heading: true,
				divided: true,
			})}
		</div>
	)
}

export function usageHrefForAccountMenu(input: {
	pathname: string
	organizations: ReadonlyArray<
		Pick<OrganizationSummary, 'slug' | 'personal' | 'role'>
	>
	username: string
}) {
	const personal =
		input.organizations.find((org) => org.personal)?.slug ??
		input.username.trim()
	const personalHref = personal ? orgUsagePath(personal) : routes.account.href()
	const usageOrgSlug = (slug: string) => {
		const org = input.organizations.find((entry) => entry.slug === slug)
		return org && orgRoleManagesBilling(org.role) ? orgUsagePath(slug) : null
	}
	const owned = orgSlugFromOrgOwnedPath(input.pathname)
	if (owned) return usageOrgSlug(owned) ?? personalHref
	const fromPath = orgSlugFromPathname(input.pathname)
	if (fromPath) return usageOrgSlug(fromPath) ?? personalHref
	return personalHref
}

function accountRows(input: {
	username: string
	currentPathname: string
	organizations: ReadonlyArray<OrganizationSummary>
}): Array<SwitcherRow> {
	const pageCurrent = (href: string) =>
		input.currentPathname === href ? ('page' as const) : undefined
	const row = (
		key: string,
		href: string,
		label: string,
		icon: IconName,
	): SwitcherRow => ({
		key,
		href,
		label,
		detail: null,
		ariaCurrent: pageCurrent(href),
		selected: false,
		leading: renderIconWell(icon),
		badge: null,
	})
	return [
		...(input.username
			? [
					row(
						'account-profile',
						routes.profile.href({ username: input.username }),
						'Public profile',
						'globe',
					),
				]
			: []),
		row('account-settings', routes.account.href(), 'Account settings', 'user'),
		row(
			'account-organizations',
			routes.accountOrganizations.href(),
			'Organizations',
			'users',
		),
		row(
			'account-usage',
			usageHrefForAccountMenu({
				pathname: input.currentPathname,
				organizations: input.organizations,
				username: input.username,
			}),
			'Usage & credits',
			'chart',
		),
	]
}

export type AccountMenuManageLink = {
	key: string
	href: string
	label: string
	detail: string | null
	icon: IconName
}

/**
 * The account menu's Manage links: one @slug row per workspace, the current
 * one first, each opening that workspace's home. Each workspace rail lists every
 * section, so any section stays two clicks from the avatar. Unlike switcher
 * rows, which keep the current page, these always open a workspace home.
 */
export function accountMenuManageLinks(input: {
	pathname: string
	organizations: ReadonlyArray<OrganizationSummary>
}): Array<AccountMenuManageLink> {
	const ordered = orderOrganizations(input.organizations)
	const currentSlug = urlOrgSlug(input)
	if (!currentSlug) return ordered.map(manageLink)
	const current = ordered.find((org) => org.slug === currentSlug)
	return [
		current
			? manageLink(current)
			: {
					key: `manage-${currentSlug}`,
					// A URL org missing from a stale session list could be a renamed
					// person's signup org, so its kind is unknown. `/-/overview`
					// serves the signup org and redirects a team to its home.
					href: orgOverviewPath(currentSlug),
					label: `@${currentSlug}`,
					detail: null,
					icon: 'home',
				},
		...ordered.filter((org) => org.slug !== currentSlug).map(manageLink),
	]
}

function manageLink(org: OrganizationSummary): AccountMenuManageLink {
	return {
		key: `manage-${org.slug}`,
		href: workspaceHomeHref(org),
		label: `@${org.slug}`,
		detail: null,
		icon: org.personal ? 'user' : 'users',
	}
}

function renderManageGroup(input: {
	links: ReadonlyArray<AccountMenuManageLink>
	currentPathname: string
	divided: boolean
}) {
	if (input.links.length === 0) return null
	return (
		<div
			role="group"
			aria-label="Manage"
			data-testid="account-menu-manage-group"
			css={input.divided ? switcherActionsCss : switcherAccountListCss}
		>
			<p css={switcherEyebrowCss}>Manage</p>
			{input.links.map((link) =>
				renderSwitcherRow({
					key: link.key,
					href: link.href,
					label: link.label,
					detail: link.detail,
					ariaCurrent: input.currentPathname === link.href ? 'page' : undefined,
					selected: false,
					leading: renderIconWell(link.icon),
					badge: null,
				}),
			)}
		</div>
	)
}

function renderAccountGroup(input: {
	username: string
	currentPathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	heading: boolean
	divided: boolean
}) {
	return (
		<div
			role="group"
			aria-label="Your account"
			data-testid="org-switcher-account-group"
			css={input.divided ? switcherActionsCss : switcherAccountListCss}
		>
			{input.heading ? <p css={switcherEyebrowCss}>Your account</p> : null}
			{accountRows(input).map(renderSwitcherRow)}
			<LogoutRow key="logout" />
		</div>
	)
}

export function AccountMenu(props: {
	organizations?: Array<OrganizationSummary>
	username: string
	displayName: string
	avatarUrl: string | null
}) {
	const [open, setOpen] = useState(false)
	const href = useLocation({ select: (location) => location.href })
	const {
		shellLocation: { pathname },
	} = useLoaderData({ from: '__root__' })
	useEffect(() => {
		const panel = document.getElementById(accountMenuPanelId)
		dismissOpenPopoverPanel(panel)
	}, [href])
	const organizations = organizationsWithSignupFallback({
		organizations: props.organizations ?? [],
		username: props.username,
	})
	const manageLinks = accountMenuManageLinks({
		pathname,
		organizations,
	})
	const name = props.displayName.trim() || props.username
	return (
		<div
			css={orgSwitcherCss}
			onKeyDown={(event) =>
				moveSwitcherFocus(event, document.getElementById(accountMenuPanelId))
			}
		>
			<button
				type="button"
				popoverTarget={accountMenuPanelId}
				aria-controls={accountMenuPanelId}
				aria-label={`${name}: your account`}
				aria-expanded={open ? 'true' : 'false'}
				data-open={open ? '' : undefined}
				data-testid="account-menu"
				css={accountMenuButtonCss}
			>
				<UserAvatar
					displayName={name}
					avatarUrl={props.avatarUrl}
					size={34}
					variant="well"
				/>
			</button>
			<div
				id={accountMenuPanelId}
				popover="auto"
				data-testid="account-menu-panel"
				css={accountMenuPanelCss}
				onToggle={(event) => setOpen(event.nativeEvent.newState === 'open')}
			>
				<div css={accountMenuIdentityCss}>
					<span css={switcherRowLabelCss}>{name}</span>
					{props.username ? (
						<span css={switcherRowDetailCss}>{`@${props.username}`}</span>
					) : null}
				</div>
				{renderManageGroup({
					links: manageLinks,
					currentPathname: pathname,
					divided: false,
				})}
				{renderAccountGroup({
					username: props.username,
					currentPathname: pathname,
					organizations,
					heading: false,
					divided: manageLinks.length > 0,
				})}
			</div>
		</div>
	)
}
const accountMenuPanelId = 'account-menu'

const orgSwitcherAnchor = '--org-switcher'

const orgSwitcherCss = {
	position: 'relative' as const,
}

/**
 * Hangs under the trigger with its inline end against the trigger's, so the
 * menu grows into the header instead of past the header's right edge. The
 * nav is a centered 72rem column, and a viewport gutter alone sits outside
 * that column on a 1440px desktop. Anchor positioning pins the end to the
 * trigger and flips when the trigger is against the start edge. Without it,
 * the same inset is the header content's inline end. Native popover, like
 * the site menu: top layer, light dismiss, Escape, and focus return come
 * from the platform.
 */
const headerContentEndInset = `max(${pageGutter}, calc((100% - ${layoutMaxWidths.extended}) / 2 + ${pageGutter}))`

const orgSwitcherPanelCss = {
	position: 'fixed' as const,
	inset: 'auto' as const,
	top: '4.15rem',
	right: headerContentEndInset,
	width: 'min(20rem, calc(100vw - 2rem))',
	maxHeight: 'calc(100dvh - 6rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '0.5rem',
	boxSizing: 'border-box' as const,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '18px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	'@supports (anchor-name: --a)': {
		positionAnchor: orgSwitcherAnchor,
		top: 'anchor(bottom)',
		right: 'anchor(right)',
		left: 'auto',
		marginTop: '0.5rem',
		positionTryFallbacks: 'flip-inline',
	},
	opacity: 0,
	translate: '0 -6px',
	transformOrigin: 'top right',
	transition: `opacity 160ms ${transitions.easeOut}, translate 160ms ${transitions.easeOut}, display 160ms allow-discrete, overlay 160ms allow-discrete`,
	'&:popover-open': {
		display: 'grid',
		opacity: 1,
		translate: '0 0',
		'@starting-style': { opacity: 0, translate: '0 -6px' },
	},
	'@media (prefers-reduced-motion: reduce)': {
		translate: 'none',
		transition: `opacity 120ms ${transitions.easeOut}, display 120ms allow-discrete, overlay 120ms allow-discrete`,
	},
}

const switcherEyebrowCss = {
	margin: 0,
	padding: '0.35rem 0.6rem 0.3rem',
	[headerNavMq]: { paddingInline: '0.85rem' },
	fontSize: typography.fontSize.xs,
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const switcherActionsCss = {
	display: 'grid',
	gap: '0.15rem',
	marginTop: '0.35rem',
	paddingTop: '0.4rem',
	borderTop: `1px solid ${colors.border}`,
}

const switcherRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	minHeight: '44px',
	padding: '0.4rem 0.6rem',
	[headerNavMq]: { paddingInline: '0.85rem' },
	boxSizing: 'border-box' as const,
	borderRadius: '12px',
	color: colors.text,
	textDecoration: 'none',
	transition: `background-color ${transitions.fast}`,
	'&[aria-current="page"]': { backgroundColor: colors.primarySoft },
	'&:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest, color: colors.text },
	},
}

const switcherButtonRowCss = {
	...switcherRowCss,
	width: '100%',
	border: 'none',
	background: 'transparent',
	font: 'inherit',
	textAlign: 'start' as const,
	cursor: 'pointer',
}

const switcherLeadingCss = {
	display: 'inline-flex',
	flexShrink: 0,
	lineHeight: 0,
}

const switcherIconWellCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '28px',
	height: '28px',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	border: `1px dashed ${colors.border}`,
	color: colors.textMuted,
	[headerNavMq]: { width: '32px', height: '32px' },
}

const switcherRowTextCss = {
	display: 'grid',
	gap: '0.1rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const switcherRowLabelCss = {
	fontWeight: 600,
	fontSize: '0.95rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[headerNavMq]: { fontSize: '1rem' },
}

const switcherRowDetailCss = {
	fontSize: typography.fontSize.sm,
	lineHeight: 1.25,
	color: colors.textMuted,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const switcherCountCss = {
	flexShrink: 0,
	minWidth: '1.4rem',
	padding: '0.1rem 0.45rem',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontSize: typography.fontSize.xs,
	fontWeight: 700,
	textAlign: 'center' as const,
	fontVariantNumeric: 'tabular-nums',
}

const switcherCheckCss = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.primaryText,
}

const accountMenuAnchor = '--account-menu'

const accountMenuButtonCss = {
	anchorName: accountMenuAnchor,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	padding: 0,
	borderRadius: radius.full,
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}`,
	'&[data-open]': { borderColor: colors.textMuted },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
}

const accountMenuIdentityCss = {
	display: 'grid',
	gap: '0.15rem',
	padding: '0.5rem 0.6rem 0.6rem',
	borderBottom: `1px solid ${colors.border}`,
	minWidth: 0,
}

const switcherAccountListCss = {
	display: 'grid',
	gap: '0.1rem',
	paddingTop: '0.35rem',
}

const accountMenuPanelCss = {
	...orgSwitcherPanelCss,
	width: 'min(16rem, calc(100vw - 2rem))',
	'@supports (anchor-name: --a)': {
		...orgSwitcherPanelCss['@supports (anchor-name: --a)'],
		positionAnchor: accountMenuAnchor,
	},
}

/** @jsxImportSource @emotion/react */
import { useDesktopMachine } from './desktop-execution.tsx'
import { Menu } from '@base-ui/react/menu'
import {
	SwitcherPopup,
	renderSwitcherRow,
	renderIconWell,
	switcherActionsCss,
	switcherEyebrowCss,
	switcherLeadingCss,
	switcherRowCss,
	switcherRowDetailCss,
	switcherRowLabelCss,
	switcherRowTextCss,
	type SwitcherRow,
} from './switcher-menu.tsx'
import { useEffect, useRef } from 'react'
import { useLoaderData, useLocation } from '@tanstack/react-router'
import { workspaceHomeHref } from '#client/routes/account-rail.ts'
import type { IconName } from './icon.tsx'
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
import { colors, radius, transitions } from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
function LogoutRow({ menu = false }: { menu?: boolean }) {
	const queryClient = useQueryClient()
	const mutation = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			await queryClient.cancelQueries()
			queryClient.clear()
			window.location.assign('/login')
		},
	})
	const button = (
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
	)
	return (
		<form
			method="post"
			onSubmit={(event) => {
				event.preventDefault()
				mutation.mutate()
			}}
			css={{ margin: 0, display: 'grid' }}
		>
			{menu ? (
				<Menu.Item
					nativeButton
					disabled={mutation.isPending}
					closeOnClick={false}
					render={button}
				/>
			) : (
				button
			)}
			{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
		</form>
	)
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
function accountMenuManageLinks(input: {
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
	menu?: boolean
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
				renderSwitcherRow(
					{
						key: link.key,
						href: link.href,
						label: link.label,
						detail: link.detail,
						ariaCurrent:
							input.currentPathname === link.href ? 'page' : undefined,
						selected: false,
						leading: renderIconWell(link.icon),
						badge: null,
					},
					input.menu,
				),
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
	menu?: boolean
}) {
	return (
		<div
			role="group"
			aria-label="Your account"
			data-testid="org-switcher-account-group"
			css={input.divided ? switcherActionsCss : switcherAccountListCss}
		>
			{input.heading ? <p css={switcherEyebrowCss}>Your account</p> : null}
			{accountRows(input).map((row) => renderSwitcherRow(row, input.menu))}
			<LogoutRow key="logout" menu={input.menu} />
		</div>
	)
}

export function AccountMenu(props: {
	placement?: 'header' | 'sidebar'
	organizations?: Array<OrganizationSummary>
	username: string
	displayName: string
	avatarUrl: string | null
}) {
	const desktop = useDesktopMachine()
	const menuActions = useRef<Menu.Root.Actions>(null)
	const href = useLocation({ select: (location) => location.href })
	const {
		shellLocation: { pathname },
	} = useLoaderData({ from: '__root__' })
	useEffect(() => menuActions.current?.close(), [href])
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
		<div css={orgSwitcherCss}>
			<Menu.Root modal={false} actionsRef={menuActions}>
				<Menu.Trigger
					id={`account-menu-${props.placement ?? 'header'}`}
					aria-label={`${name}: your account`}
					data-testid="account-menu"
					css={[
						accountMenuButtonCss,
						props.placement === 'sidebar' && {
							width: '38px',
							height: '38px',
							'@media (pointer: coarse)': { width: '44px', height: '44px' },
						},
					]}
				>
					<UserAvatar
						displayName={name}
						avatarUrl={props.avatarUrl}
						size={props.placement === 'sidebar' ? 28 : 34}
						variant="well"
					/>
				</Menu.Trigger>
				<SwitcherPopup
					testId="account-menu-panel"
					label="Your account"
					align={props.placement === 'sidebar' ? 'start' : 'end'}
					width="16rem"
				>
					<div css={accountMenuIdentityCss}>
						<span css={switcherRowLabelCss}>{name}</span>
						{props.username ? (
							<span css={switcherRowDetailCss}>{`@${props.username}`}</span>
						) : null}
					</div>
					{desktop
						? renderSwitcherRow(
								{
									key: 'this-machine',
									href: '/account/execution-contexts',
									label: 'This machine',
									detail: null,
									ariaCurrent: undefined,
									selected: false,
									leading: renderIconWell('server'),
									badge: null,
								},
								true,
							)
						: null}
					{renderManageGroup({
						links: manageLinks,
						currentPathname: pathname,
						divided: false,
						menu: true,
					})}
					{renderAccountGroup({
						username: props.username,
						currentPathname: pathname,
						organizations,
						heading: false,
						divided: manageLinks.length > 0,
						menu: true,
					})}
				</SwitcherPopup>
			</Menu.Root>
		</div>
	)
}

const orgSwitcherCss = {
	position: 'relative' as const,
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

const accountMenuButtonCss = {
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
	'&[data-popup-open]': { borderColor: colors.textMuted },
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

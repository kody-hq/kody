/** @jsxImportSource @emotion/react */
import { useEffect, useRef } from 'react'
import { Menu } from '@base-ui/react/menu'
import { useLocation } from '@tanstack/react-router'
import { workspaceSwitchHref } from '#client/routes/account-rail.ts'
import {
	SwitcherPopup,
	renderIconWell,
	renderSwitcherRow,
	switcherActionsCss,
	switcherEyebrowCss,
	switcherListCss,
	type SwitcherRow,
} from './switcher-menu.tsx'
import { renderIcon } from './icon.tsx'
import {
	orgIdentity,
	orgRoleLabel,
	orgSwitcherEntries,
	type OrganizationSummary,
	type WorkspaceSwitchTarget,
	type OrgSwitcherEntry,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import { UserAvatar } from './user-avatar.tsx'

export type WorkspaceSwitcherData = {
	/** The organization the rail belongs to. */
	currentSlug: string
	organizations: ReadonlyArray<OrganizationSummary>
	inviteCount: number
	username: string
	displayName: string
	avatarUrl: string | null
	switchTarget?: WorkspaceSwitchTarget
}

/**
 * Desktop rail heading or the narrow rail drawer. Both render on every page
 * (CSS shows one), so each needs its own panel id and anchor name.
 */
export type WorkspaceSwitcherPlacement = 'rail' | 'drawer'

function triggerTestId(placement: WorkspaceSwitcherPlacement) {
	switch (placement) {
		case 'rail':
			return 'org-switcher'
		case 'drawer':
			return 'org-switcher-drawer'
		default: {
			const exhaustive: never = placement
			return exhaustive
		}
	}
}

/**
 * The organization rows, then Create organization and Invites. Each org row
 * keeps the current page when the target org can open it, otherwise opens
 * that org's workspace home.
 */
export function workspaceSwitcherRows(data: WorkspaceSwitcherData) {
	const viewer = { displayName: data.displayName, avatarUrl: data.avatarUrl }
	const listed = data.organizations.some((org) => org.slug === data.currentSlug)
	// Stale session lists can omit the URL org on `/@slug/-/…`. Show a
	// member-shaped row for it so it can still be seen and re-selected,
	// without inventing Owner-only (Billing) links.
	const synthesized: OrganizationSummary | null = listed
		? null
		: {
				slug: data.currentSlug,
				displayName: null,
				role: 'member',
				personal: data.currentSlug === data.username,
			}
	const toRow = (entry: OrgSwitcherEntry): SwitcherRow => {
		switch (entry.kind) {
			case 'create':
				return {
					key: 'create',
					href: routes.accountOrganizationsNew.href(),
					label: 'Create organization',
					detail: null,
					ariaCurrent: undefined,
					selected: false,
					leading: renderIconWell('plus'),
					badge: null,
				}
			case 'invites':
				return {
					key: 'invites',
					href: `${routes.accountOrganizations.href()}#invites`,
					label: 'Invites',
					detail: null,
					ariaCurrent: undefined,
					selected: false,
					leading: renderIconWell('mail'),
					badge: entry.count > 0 ? String(entry.count) : null,
				}
			case 'org': {
				const identity = orgIdentity(entry.org, viewer)
				const role = entry.showRole ? orgRoleLabel(entry.org.role) : null
				const selected = entry.org.slug === data.currentSlug
				return {
					key: entry.org.slug,
					href: workspaceSwitchHref(data.switchTarget, entry.org),
					label: identity.name,
					detail: identity.hasName
						? [identity.handle, role].filter(Boolean).join(' · ')
						: role,
					ariaCurrent: selected ? 'true' : undefined,
					selected,
					leading: (
						<UserAvatar
							displayName={identity.avatarName}
							avatarUrl={identity.avatarUrl}
							size={28}
							variant="well"
						/>
					),
					badge: null,
				}
			}
			default: {
				const exhaustive: never = entry
				return exhaustive
			}
		}
	}
	const entries = orgSwitcherEntries(data.organizations, data.inviteCount)
	const orgRows = entries.filter((entry) => entry.kind === 'org').map(toRow)
	return {
		current:
			data.organizations.find((org) => org.slug === data.currentSlug) ??
			synthesized,
		orgRows: synthesized
			? [toRow({ kind: 'org', org: synthesized, showRole: true }), ...orgRows]
			: orgRows,
		actionRows: entries.filter((entry) => entry.kind !== 'org').map(toRow),
	}
}

/** The current organization opens the workspace switcher in the rail or drawer. */
export function WorkspaceSwitcher(
	props: WorkspaceSwitcherData & { placement: WorkspaceSwitcherPlacement },
) {
	const menuActions = useRef<Menu.Root.Actions>(null)
	const href = useLocation({ select: (location) => location.href })
	const trigger = useRef<HTMLButtonElement>(null)
	useEffect(() => menuActions.current?.close(), [href, props.placement])
	useEffect(() => {
		const drawer = trigger.current?.closest('details')
		if (!drawer) return
		const close = () => {
			if (!drawer.open) menuActions.current?.close()
		}
		drawer.addEventListener('toggle', close)
		return () => drawer.removeEventListener('toggle', close)
	}, [])
	const { placement } = props
	const { current, orgRows, actionRows } = workspaceSwitcherRows(props)
	const identity = current
		? orgIdentity(current, {
				displayName: props.displayName,
				avatarUrl: props.avatarUrl,
			})
		: null
	const label = identity?.handle ?? `@${props.currentSlug}`
	return (
		<div data-account-nav-heading css={headingCss}>
			<Menu.Root modal={false} actionsRef={menuActions}>
				<Menu.Trigger
					id={triggerTestId(placement)}
					ref={trigger}
					aria-label={`${label}: switch organization`}
					title={current?.displayName ?? undefined}
					data-testid={triggerTestId(placement)}
					css={triggerCss}
				>
					<UserAvatar
						displayName={identity?.avatarName ?? label}
						avatarUrl={identity?.avatarUrl ?? null}
						size={24}
						variant="well"
					/>
					<span data-rail-label css={triggerLabelCss}>
						{label}
					</span>
					<span data-rail-label aria-hidden="true" css={chevronCss}>
						{renderIcon('chevron-down', { size: '1rem' })}
					</span>
				</Menu.Trigger>
				<SwitcherPopup
					testId={`${triggerTestId(placement)}-panel`}
					label="Switch organization"
					align="start"
					width={placement === 'drawer' ? 'var(--anchor-width)' : '20rem'}
				>
					<p css={switcherEyebrowCss}>Organizations</p>
					<div role="group" aria-label="Organizations" css={switcherListCss}>
						{orgRows.map((row) => renderSwitcherRow(row, true))}
					</div>
					{actionRows.length > 0 ? (
						<div css={switcherActionsCss}>
							{actionRows.map((row) => renderSwitcherRow(row, true))}
						</div>
					) : null}
				</SwitcherPopup>
			</Menu.Root>
		</div>
	)
}

const headingCss = {
	display: 'grid',
	gap: '0.3rem',
	padding: '0 0 0.6rem',
	margin: 0,
	minWidth: 0,
}

const triggerCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
	width: '100%',
	minWidth: 0,
	minHeight: '44px',
	padding: '0.3rem 0.5rem 0.3rem 0.4rem',
	boxSizing: 'border-box' as const,
	borderRadius: '12px',
	border: `1px solid color-mix(in srgb, ${colors.border} 30%, ${colors.surface})`,
	background: colors.surface,
	color: colors.text,
	// Buttons do not inherit the page face on their own.
	font: `650 0.875rem/1 ${typography.fontFamily}`,
	textAlign: 'start' as const,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}`,
	'&[data-popup-open]': {
		borderColor: `color-mix(in srgb, ${colors.border} 65%, ${colors.surface})`,
		backgroundColor: colors.surface,
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 3,
	},
	[hoverMq]: {
		'&:hover': {
			borderColor: `color-mix(in srgb, ${colors.border} 65%, ${colors.surface})`,
		},
	},
}

const triggerLabelCss = {
	flex: '1 1 auto',
	minWidth: 0,
	// The font shorthand is line-height 1; overflow on that line box would
	// clip descenders and the @.
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const chevronCss = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.textMuted,
	transition: `rotate 180ms ${transitions.easeOut}`,
	'[data-popup-open] > &': { rotate: '180deg' },
	'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
}

/** @jsxImportSource @emotion/react */
import { useState, useEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { workspaceSwitchHref } from '#client/routes/account-rail.ts'
import {
	dismissOpenPopoverPanel,
	moveSwitcherFocus,
	renderIconWell,
	renderSwitcherRow,
	switcherActionsCss,
	switcherEyebrowCss,
	switcherListCss,
	switcherPanelCss,
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
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
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

export function workspaceSwitcherPanelId(
	placement: WorkspaceSwitcherPlacement,
) {
	return `workspace-switcher-${placement}`
}

function anchorName(placement: WorkspaceSwitcherPlacement) {
	return `--workspace-switcher-${placement}`
}

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
function workspaceSwitcherRows(data: WorkspaceSwitcherData) {
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

/**
 * The organization switcher, drawn where the workspace rail names its
 * organization: the "Workspace" label stays, and the name under it opens
 * the list of organizations to switch to.
 */
export function WorkspaceSwitcher(
	props: WorkspaceSwitcherData & { placement: WorkspaceSwitcherPlacement },
) {
	const [open, setOpen] = useState(false)
	const href = useLocation({ select: (location) => location.href })
	useEffect(() => {
		dismissOpenPopoverPanel(
			document.getElementById(workspaceSwitcherPanelId(props.placement)),
		)
	}, [href, props.placement])
	const { placement } = props
	const id = workspaceSwitcherPanelId(placement)
	const { current, orgRows, actionRows } = workspaceSwitcherRows(props)
	const identity = current
		? orgIdentity(current, {
				displayName: props.displayName,
				avatarUrl: props.avatarUrl,
			})
		: null
	const label = identity?.handle ?? `@${props.currentSlug}`
	return (
		<div
			data-account-nav-heading
			css={headingCss}
			onKeyDown={(event) =>
				moveSwitcherFocus(event, document.getElementById(id))
			}
		>
			<span aria-hidden="true" css={eyebrowCss}>
				Workspace
			</span>
			<button
				type="button"
				popoverTarget={id}
				aria-controls={id}
				aria-label={`${label}: switch organization`}
				aria-expanded={open ? 'true' : 'false'}
				data-open={open ? '' : undefined}
				data-testid={triggerTestId(placement)}
				css={{ ...triggerCss, anchorName: anchorName(placement) }}
			>
				<UserAvatar
					displayName={identity?.avatarName ?? label}
					avatarUrl={identity?.avatarUrl ?? null}
					size={24}
					variant="well"
				/>
				<span css={triggerLabelCss}>{label}</span>
				<span aria-hidden="true" css={chevronCss}>
					{renderIcon('chevron-down', { size: '1rem' })}
				</span>
			</button>
			<div
				id={id}
				popover="auto"
				data-testid={`${triggerTestId(placement)}-panel`}
				css={placement === 'rail' ? railPanelCss : drawerPanelCss}
				onToggle={(event) => setOpen(event.newState === 'open')}
			>
				<p css={switcherEyebrowCss}>Organizations</p>
				<ul aria-label="Organizations" css={switcherListCss}>
					{orgRows.map((row) => (
						<li key={row.key}>{renderSwitcherRow(row)}</li>
					))}
				</ul>
				{actionRows.length > 0 ? (
					<div css={switcherActionsCss}>
						{actionRows.map(renderSwitcherRow)}
					</div>
				) : null}
			</div>
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

const eyebrowCss = {
	padding: '0 0.7rem',
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
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
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.text,
	// Buttons do not inherit the page face on their own.
	font: `650 0.98rem/1 ${typography.fontFamily}`,
	textAlign: 'start' as const,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}`,
	'&[data-open]': {
		borderColor: colors.textMuted,
		backgroundColor: colors.surface,
	},
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
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
	'[data-open] > &': { rotate: '180deg' },
	'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
}

/**
 * Hangs under the trigger, start edges aligned, so it grows over the page
 * content. Without anchor positioning it sits at the rail's inline start:
 * the shell is a centered 72rem column with the rail at its gutter.
 */
const railPanelCss = {
	...switcherPanelCss,
	top: '9rem',
	left: `max(${pageGutter}, calc((100% - ${layoutMaxWidths.extended}) / 2 + ${pageGutter}))`,
	width: 'min(20rem, calc(100vw - 2rem))',
	transformOrigin: 'top left',
	'@supports (anchor-name: --a)': {
		positionAnchor: anchorName('rail'),
		top: 'anchor(bottom)',
		left: 'anchor(left)',
		right: 'auto',
		marginTop: '0.4rem',
		positionTryFallbacks: 'flip-block',
	},
}

/** Spans the drawer under its trigger; the gutter is the fallback inset. */
const drawerPanelCss = {
	...switcherPanelCss,
	top: '9rem',
	left: pageGutter,
	right: pageGutter,
	width: 'auto',
	transformOrigin: 'top center',
	'@supports (anchor-name: --a)': {
		positionAnchor: anchorName('drawer'),
		top: 'anchor(bottom)',
		left: 'anchor(left)',
		right: 'anchor(right)',
		marginTop: '0.4rem',
		positionTryFallbacks: 'flip-block',
	},
}

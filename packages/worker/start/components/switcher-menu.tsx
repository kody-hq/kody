/** @jsxImportSource @emotion/react */
import { dismissOpenPopoverPanel, isPopoverOpen } from '#client/popover-open.ts'
import { type ReactNode, type KeyboardEvent } from 'react'
import { SiteLink } from './site-link.tsx'
import { type IconName, renderIcon } from './icon.tsx'
import {
	colors,
	radius,
	shadows,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

export { dismissOpenPopoverPanel }

/**
 * Below this the site header folds its nav and session corner into the menu
 * panel, so rows grow to phone-sized targets.
 */
const headerNavMq = '@media (max-width: 820px)'

export type SwitcherRow = {
	key: string
	href: string
	label: string
	detail: string | null
	ariaCurrent: 'true' | 'page' | undefined
	/** The organization the page is acting in; drawn with a check. */
	selected: boolean
	leading: ReactNode
	badge: string | null
}

export function renderSwitcherRow(row: SwitcherRow) {
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

export function renderIconWell(name: IconName) {
	return (
		<span aria-hidden="true" css={switcherIconWellCss}>
			{renderIcon(name, { size: '1rem' })}
		</span>
	)
}

/** Focus order for the arrow keys: the trigger, then every row in the panel. */
export function moveSwitcherFocus(
	event: KeyboardEvent,
	panel: HTMLElement | null,
) {
	if (!panel || !isPopoverOpen(panel)) return
	const rows = Array.from(
		panel.querySelectorAll<HTMLElement>('a[href], button'),
	)
	if (rows.length === 0) return
	const index = rows.indexOf(document.activeElement as HTMLElement)
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

/**
 * A dropdown panel: native popover, so the top layer, light dismiss, Escape,
 * and focus return come from the platform. Callers add the position.
 */
export const switcherPanelCss = {
	position: 'fixed' as const,
	inset: 'auto' as const,
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
	opacity: 0,
	translate: '0 -6px',
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

export const switcherEyebrowCss = {
	margin: 0,
	padding: '0.35rem 0.6rem 0.3rem',
	[headerNavMq]: { paddingInline: '0.85rem' },
	fontSize: typography.fontSize.xs,
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

export const switcherListCss = {
	display: 'grid',
	gap: '0.15rem',
	listStyle: 'none',
	margin: 0,
	padding: 0,
}

export const switcherActionsCss = {
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

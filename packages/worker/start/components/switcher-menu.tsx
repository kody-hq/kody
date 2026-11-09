/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { overlayPopupCss, overlayPositionerCss } from './overlay-styles.ts'
import { SiteLink } from './site-link.tsx'
import { type IconName, renderIcon } from './icon.tsx'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

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

export function renderSwitcherRow(row: SwitcherRow, menu = false) {
	const link = (
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
	return menu ? <Menu.LinkItem key={row.key} render={link} /> : link
}

export function renderIconWell(name: IconName) {
	return (
		<span aria-hidden="true" css={switcherIconWellCss}>
			{renderIcon(name, { size: '1rem' })}
		</span>
	)
}

export function SwitcherPopup({
	testId,
	label,
	align,
	width,
	children,
}: {
	testId: string
	label: string
	align: 'start' | 'end'
	width: string
	children: ReactNode
}) {
	return (
		<Menu.Portal>
			<Menu.Positioner align={align} sideOffset={6} css={overlayPositionerCss}>
				<Menu.Popup
					data-testid={testId}
					aria-label={label}
					css={{
						...overlayPopupCss,
						display: 'grid',
						width,
						maxHeight: 'var(--available-height)',
						padding: '0.5rem',
						transition: `opacity 160ms ${transitions.easeOut}, translate 160ms ${transitions.easeOut}`,
						'&[data-starting-style], &[data-ending-style]': {
							opacity: 0,
							translate: '0 -6px',
						},
						'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
					}}
				>
					{children}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	)
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

export const switcherRowCss = {
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
	'&[data-highlighted]': { backgroundColor: colors.primarySoft },
	'&:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest, color: colors.text },
	},
}

export const switcherLeadingCss = {
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

export const switcherRowTextCss = {
	display: 'grid',
	gap: '0.1rem',
	minWidth: 0,
	flex: '1 1 auto',
}

export const switcherRowLabelCss = {
	fontWeight: 600,
	fontSize: '0.95rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[headerNavMq]: { fontSize: '1rem' },
}

export const switcherRowDetailCss = {
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

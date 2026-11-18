/** @jsxImportSource @emotion/react */
import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ComponentProps, ReactNode } from 'react'
import { colors, transitions } from '#universal/styles/tokens.ts'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from './overlay-styles.ts'
import { SiteLink } from './site-link.tsx'

export type MenuActions = BaseMenu.Root.Actions

/**
 * Menu of actions or links (WAI-ARIA menu button). Arrow keys move the
 * highlight, typing jumps to an item, Escape closes and returns focus to
 * the trigger. Non-modal by default so the page keeps scrolling.
 */
export function Menu({
	modal = false,
	...props
}: ComponentProps<typeof BaseMenu.Root>) {
	return <BaseMenu.Root modal={modal} {...props} />
}

/**
 * Opens the menu. Pass `render={<Button ... />}` to use the shared Button
 * look; otherwise style the trigger for layout only.
 */
export const MenuTrigger = BaseMenu.Trigger

export type MenuContentProps = Omit<
	ComponentProps<typeof BaseMenu.Popup>,
	'aria-label' | 'children'
> & {
	/** Names the menu for assistive tech. */
	'aria-label': string
	align?: 'start' | 'center' | 'end'
	side?: 'top' | 'bottom' | 'left' | 'right' | 'inline-start' | 'inline-end'
	sideOffset?: number
	/** Point or element to open next to instead of the trigger (context menus). */
	anchor?: ComponentProps<typeof BaseMenu.Positioner>['anchor']
	/** Portal target; defaults to the document body. */
	container?: ComponentProps<typeof BaseMenu.Portal>['container']
	children: ReactNode
}

/** The floating panel: portal, positioning, and light dismiss. */
export function MenuContent({
	align = 'start',
	side,
	sideOffset = 4,
	anchor,
	container,
	children,
	...props
}: MenuContentProps) {
	return (
		<BaseMenu.Portal container={container}>
			<BaseMenu.Positioner
				align={align}
				side={side}
				sideOffset={sideOffset}
				anchor={anchor}
				css={overlayPositionerCss}
			>
				<BaseMenu.Popup css={menuPopupCss} {...props}>
					{children}
				</BaseMenu.Popup>
			</BaseMenu.Positioner>
		</BaseMenu.Portal>
	)
}

type ItemTone = { tone?: 'default' | 'danger' }

/** Runs an action when chosen. */
export function MenuItem({
	tone = 'default',
	...props
}: ComponentProps<typeof BaseMenu.Item> & ItemTone) {
	return (
		<BaseMenu.Item
			// A custom `render` row draws its own look.
			css={
				props.render
					? undefined
					: [menuItemCss, tone === 'danger' && { color: colors.danger }]
			}
			{...props}
		/>
	)
}

/** Navigates. Renders a `SiteLink`, so client routing and `reloadDocument` work. */
export function MenuLinkItem({
	href,
	reloadDocument,
	render,
	...props
}: Omit<ComponentProps<typeof BaseMenu.LinkItem>, 'href'> & {
	href: string
	reloadDocument?: boolean
}) {
	return (
		<BaseMenu.LinkItem
			// A custom `render` row draws its own look.
			css={render ? undefined : menuItemCss}
			render={
				render ?? <SiteLink href={href} reloadDocument={reloadDocument} />
			}
			{...props}
		/>
	)
}

/** Toggles a setting; draws its own check. */
export function MenuCheckboxItem({
	children,
	...props
}: ComponentProps<typeof BaseMenu.CheckboxItem>) {
	return (
		<BaseMenu.CheckboxItem css={menuItemCss} {...props}>
			<span aria-hidden="true" css={checkSlotCss}>
				<BaseMenu.CheckboxItemIndicator>✓</BaseMenu.CheckboxItemIndicator>
			</span>
			{children}
		</BaseMenu.CheckboxItem>
	)
}

export function MenuSeparator(
	props: ComponentProps<typeof BaseMenu.Separator>,
) {
	return <BaseMenu.Separator css={separatorCss} {...props} />
}

/** Labels a run of related items. */
export function MenuGroup({
	label,
	children,
	...props
}: ComponentProps<typeof BaseMenu.Group> & { label: ReactNode }) {
	return (
		<BaseMenu.Group {...props}>
			<BaseMenu.GroupLabel css={groupLabelCss}>{label}</BaseMenu.GroupLabel>
			{children}
		</BaseMenu.Group>
	)
}

const menuPopupCss = {
	...overlayPopupCss,
	minWidth: 170,
	transition: `opacity 160ms ${transitions.easeOut}, translate 160ms ${transitions.easeOut}`,
	'&[data-starting-style], &[data-ending-style]': {
		opacity: 0,
		translate: '0 -6px',
	},
	'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const

const menuItemCss = {
	...overlayItemCss,
	minHeight: 32,
	'@media (pointer: coarse)': { minHeight: 44 },
} as const

const checkSlotCss = { display: 'inline-block', width: '1rem' }

const separatorCss = {
	height: 1,
	margin: '4px 0',
	border: 0,
	background: colors.border,
}

const groupLabelCss = {
	padding: '6px 10px 2px',
	fontSize: 12,
	fontWeight: 600,
	color: colors.textMuted,
}

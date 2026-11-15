import type { CSSObject } from '@emotion/react'
import { surfaceCardCss } from './surface.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * Hover styles that move or lift must be gated on a real hover device —
 * touch taps otherwise leave elements stuck in their hover state.
 */
export const hoverMq = '@media (hover: hover) and (pointer: fine)'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export type ButtonStyleOptions = {
	/**
	 * `primary` is the filled call to action, `secondary` its outlined
	 * sibling, `ghost` a borderless control for toolbars and quiet actions,
	 * and `danger` the outlined destructive action that fills on hover.
	 */
	variant?: ButtonVariant
	/**
	 * `sm` (default, 36px) for ordinary content and settings actions, `md`
	 * (40px) for form submits, `lg` (48px) for prominent calls to action, `xs`
	 * for value-sized controls that ride along with an id or a toolbar.
	 */
	size?: ButtonSize
	/** Square button holding only an icon; pair it with an accessible name. */
	iconOnly?: boolean
	mobileFullWidth?: boolean
}

const buttonSizes = {
	xs: {
		paddingBlock: '0.375rem',
		height: '1.75rem',
		coarseHeight: '2.25rem',
		paddingInline: '0.5rem',
		gap: '0.25rem',
		font: '650 0.75rem/1rem',
		radius: '0.375rem',
		squircleRadius: '0.75rem',
	},
	sm: {
		paddingBlock: '0.5rem',
		height: '2.25rem',
		coarseHeight: '2.75rem',
		paddingInline: '0.875rem',
		gap: '0.375rem',
		font: '650 0.875rem/1.25rem',
		radius: '0.625rem',
		squircleRadius: '1.125rem',
	},
	md: {
		paddingBlock: '0.625rem',
		height: '2.5rem',
		coarseHeight: '2.75rem',
		paddingInline: '1.125rem',
		gap: '0.5rem',
		font: '650 1rem/1.25rem',
		radius: '0.625rem',
		squircleRadius: '1.125rem',
	},
	lg: {
		paddingBlock: '1rem',
		height: '3rem',
		coarseHeight: '3rem',
		paddingInline: '1.7rem',
		gap: '0.5rem',
		font: '650 1rem/1',
		radius: '0.625rem',
		squircleRadius: '1.125rem',
	},
} as const satisfies Record<ButtonSize, Record<string, string>>

/**
 * Squircle corners: a rounded rectangle everywhere, a superellipse where
 * `corner-shape` is supported. Buttons get it through `getButtonCss`;
 * specialized controls that are not buttons (tabs, segmented filters, toggles)
 * use it directly so no control falls back to the full-radius pill.
 */
export function getSquircleCss(size: ButtonSize = 'sm') {
	const { radius, squircleRadius } = buttonSizes[size]
	return {
		borderRadius: radius,
		'@supports (corner-shape: squircle)': {
			borderRadius: squircleRadius,
			cornerShape: 'squircle',
		},
	}
}

const pressTransform = 'translateY(0) scale(0.97)'

function getButtonVariantCss(variant: ButtonVariant) {
	switch (variant) {
		case 'primary':
			return {
				backgroundColor: colors.primary,
				color: colors.onPrimary,
				[hoverMq]: {
					'&:not(:disabled):hover': {
						backgroundColor: colors.primaryHover,
						color: colors.onPrimary,
						transform: 'translateY(-1px)',
						boxShadow: `0 6px 20px -8px oklch(from ${colors.primary} l c h / 0.6)`,
					},
					'&:not(:disabled):active': { transform: pressTransform },
				},
			}
		case 'secondary':
			return {
				backgroundColor: 'transparent',
				color: colors.text,
				boxShadow: `inset 0 0 0 1.5px ${colors.border}`,
				[hoverMq]: {
					'&:not(:disabled):hover': {
						backgroundColor: colors.surface,
						color: colors.text,
						transform: 'translateY(-1px)',
						boxShadow: `inset 0 0 0 1.5px ${colors.textMuted}`,
					},
					'&:not(:disabled):active': { transform: pressTransform },
				},
			}
		case 'ghost':
			return {
				backgroundColor: 'transparent',
				color: colors.text,
				[hoverMq]: {
					'&:not(:disabled):hover': {
						backgroundColor: `color-mix(in srgb, ${colors.text} 8%, transparent)`,
						color: colors.text,
					},
				},
			}
		case 'danger':
			return {
				backgroundColor: 'transparent',
				color: colors.danger,
				boxShadow: `inset 0 0 0 1.5px ${colors.danger}`,
				'@supports (color: oklch(from red l c h / 0.45))': {
					boxShadow: `inset 0 0 0 1.5px oklch(from ${colors.danger} l c h / 0.45)`,
				},
				[hoverMq]: {
					'&:not(:disabled):hover': {
						backgroundColor: `oklch(from ${colors.danger} l c h / 0.12)`,
						transform: 'translateY(-1px)',
						boxShadow: `inset 0 0 0 1.5px ${colors.danger}`,
					},
					'&:not(:disabled):active': { transform: pressTransform },
				},
			}
	}
}

function buildButtonCss(options: ButtonStyleOptions) {
	const size = buttonSizes[options.size ?? 'sm']
	return {
		boxSizing: 'border-box' as const,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: size.gap,
		minHeight: size.height,
		padding: options.iconOnly
			? 0
			: `${size.paddingBlock} ${size.paddingInline}`,
		...(options.iconOnly ? { minWidth: size.height, flex: 'none' } : {}),
		margin: 0,
		border: 'none',
		font: `${size.font} ${typography.fontFamilyDisplay}`,
		textAlign: 'center' as const,
		textDecoration: 'none',
		whiteSpace: 'nowrap' as const,
		cursor: 'pointer',
		...getSquircleCss(options.size),
		'@media (any-pointer: coarse)': {
			minHeight: size.coarseHeight,
			...(options.iconOnly ? { minWidth: size.coarseHeight } : {}),
		},
		transition: `background-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}, opacity 160ms ${transitions.easeOut}`,
		'&:disabled, &[aria-disabled="true"]': {
			cursor: 'not-allowed',
			opacity: 0.7,
		},
		// Press feedback works everywhere, including touch.
		'&:not(:disabled):active': { transform: pressTransform },
		...getButtonVariantCss(options.variant ?? 'primary'),
		...(options.mobileFullWidth ? { [mq.mobile]: { width: '100%' } } : {}),
		// Declared last so reduced motion wins over both the press and the lift.
		'@media (prefers-reduced-motion: reduce)': {
			transition: `background-color ${transitions.normal}, border-color ${transitions.normal}, color ${transitions.normal}, opacity ${transitions.normal}, box-shadow ${transitions.normal}`,
			'&:not(:disabled):hover': { transform: 'none' },
			'&:not(:disabled):active': { transform: 'none' },
		},
	}
}

const buttonCssCache = new Map<string, ReturnType<typeof buildButtonCss>>()

/**
 * The one button look: every button and button-styled link renders through
 * `<Button>` (start/components/button.tsx), which applies this. Call it
 * directly only for elements `<Button>` cannot be (a `<label>` for a file
 * input, a `<summary>`, static HTML via `renderButtonStylesheet`).
 */
export function getButtonCss(options: ButtonStyleOptions = {}) {
	const key = `${options.variant ?? 'primary'}:${options.size ?? 'sm'}:${options.iconOnly ? 1 : 0}:${options.mobileFullWidth ? 1 : 0}`
	let css = buttonCssCache.get(key)
	if (!css) {
		css = buildButtonCss(options)
		buttonCssCache.set(key, css)
	}
	return css
}

type StaticCssObject = { [key: string]: string | number | StaticCssObject }

function nestSelector(parent: string, child: string) {
	const parents = parent.split(',').map((part) => part.trim())
	return child
		.split(',')
		.map((part) => part.trim())
		.flatMap((part) =>
			parents.map((outer) =>
				part.includes('&') ? part.replaceAll('&', outer) : `${outer} ${part}`,
			),
		)
		.join(',')
}

/** Serializes an Emotion-style object for documents that load no app bundle. */
export function renderStaticCss(selector: string, styles: object): string {
	const declarations: Array<string> = []
	const nested: Array<string> = []
	for (const [key, value] of Object.entries(styles as StaticCssObject)) {
		if (typeof value === 'object') {
			nested.push(
				key.startsWith('@')
					? `${key}{${renderStaticCss(selector, value)}}`
					: renderStaticCss(nestSelector(selector, key), value),
			)
		} else {
			const property = key.startsWith('--')
				? key
				: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
			declarations.push(`${property}:${value}`)
		}
	}
	const own = declarations.length
		? `${selector}{${declarations.join(';')}}`
		: ''
	return own + nested.join('')
}

/**
 * The `getButtonCss` look as plain CSS for static documents (the uncaught
 * error page), keyed by selector, so those buttons cannot drift from
 * `<Button>`.
 */
export function renderButtonStylesheet(
	rules: Record<string, ButtonStyleOptions>,
) {
	return Object.entries(rules)
		.map(([selector, options]) =>
			renderStaticCss(selector, getButtonCss(options)),
		)
		.join('')
}

/**
 * Layout-stable label swap for buttons whose text changes with state
 * ("Copy" → "Copied", "Create account" → "Creating…"). Every label
 * renders grid-stacked in the same cell so the widest one reserves the width
 * — swapping never shifts layout. The outgoing label exits fast; the incoming
 * one lands slower and slightly delayed, through a light blur that masks the
 * two texts overlapping (same blur-crossfade as the prototype's `copy-swap`).
 *
 * Markup contract: children are `<span data-swap-label>` with `data-active`
 * on the current one and `aria-hidden="true"` on the rest. Compose onto a
 * button getter with `mergeCss` so nested media blocks combine.
 */
export function getSwapLabelCss() {
	return {
		display: 'inline-grid',
		justifyItems: 'center',
		alignItems: 'center',
		'& > [data-swap-label]': {
			gridArea: '1 / 1',
			whiteSpace: 'nowrap' as const,
			// Exit: fast, so the old label is mostly gone before the new lands.
			transition: `opacity 90ms ${transitions.easeOut}, filter 90ms ${transitions.easeOut}, scale 90ms ${transitions.easeOut}`,
		},
		'& > [data-swap-label]:not([data-active])': {
			opacity: 0,
			filter: 'blur(3px)',
			scale: '0.96',
		},
		'& > [data-swap-label][data-active]': {
			// Entrance: slower and slightly delayed — asymmetric on purpose.
			transition: `opacity 200ms ${transitions.easeOut} 50ms, filter 200ms ${transitions.easeOut} 50ms, scale 200ms ${transitions.easeOut} 50ms`,
		},
		'@media (prefers-reduced-motion: reduce)': {
			'& > [data-swap-label]': {
				transition: `opacity 90ms ${transitions.easeOut}`,
				filter: 'none',
				scale: 'none',
			},
			'& > [data-swap-label][data-active]': {
				transition: `opacity 200ms ${transitions.easeOut} 50ms`,
			},
		},
	}
}

export const pageHeadCss = {
	position: 'relative' as const,
	textAlign: 'center' as const,
	// The glow is a backdrop, so it has to paint under the heading. A
	// positioned pseudo otherwise paints after its static in-flow siblings.
	// `isolate` scopes the negative z-index to this element, so the glow
	// still sits above whatever background this container itself carries.
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-70% -20% -160%',
		background: `radial-gradient(ellipse 44% 55% at 50% 38%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.4rem, 5.5vw, 3.8rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.04,
	},
	'& h1 em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
	'& > p': {
		margin: '1rem auto 0',
		color: colors.textMuted,
		fontSize: '1.08rem',
		maxWidth: '46ch',
		textWrap: 'balance' as const,
	},
}

/**
 * Accent-bar callout: a quiet labeled aside with a solid accent border on
 * its left side. The rule this encodes (see
 * docs/contributing/code-style.md — "Accent borders"): the side carrying a
 * solid accent border gets NO border radius; round only the corners facing
 * away from the bar. A rounded corner dissolving into a straight accent bar
 * reads as generated, not designed.
 */
export function getAccentCalloutCss(options?: { accentColor?: string }) {
	const accent =
		options?.accentColor ?? `oklch(from ${colors.primary} l c h / 0.45)`
	return {
		display: 'grid',
		gap: '0.35rem',
		padding: '0.9rem 1.1rem',
		borderLeft: `3px solid ${accent}`,
		/* Square against the accent bar, rounded away from it. */
		borderRadius: `0 ${radius.md} ${radius.md} 0`,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
		'&::selection, & *::selection': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.32)`,
		},
	}
}

/**
 * The lantern Kody holds actually casts light. Screen blend adds warmth over
 * his paws without a background halo. Spread into the css object of the
 * positioned wrapper around the mascot illustration; `maxWidth` caps the glow
 * for the wrapper's rendered size.
 */
export function getLanternGlowCss(options: { maxWidth: string }) {
	return {
		'&::after': {
			content: '""',
			position: 'absolute' as const,
			left: '50%',
			top: '63%',
			width: `min(36%, ${options.maxWidth})`,
			aspectRatio: '4 / 3',
			transform: 'translate(-50%, -50%)',
			borderRadius: '50%',
			background:
				'radial-gradient(closest-side, var(--lantern-glow), transparent 72%)',
			mixBlendMode: 'screen' as const,
			pointerEvents: 'none' as const,
		},
		'@media (prefers-reduced-motion: no-preference)': {
			'&::after': {
				animation: 'lantern-breathe 4.5s ease-in-out infinite alternate',
			},
		},
		'@keyframes lantern-breathe': {
			from: { opacity: 0.55 },
			to: { opacity: 1 },
		},
	}
}

const markdownTableCss = {
	'& [data-markdown-table]': {
		margin: '1.15rem 0 0',
		maxWidth: '100%',
		overflowX: 'auto' as const,
	},
	'& table': {
		display: 'table' as const,
		width: '100%',
		borderCollapse: 'collapse' as const,
		overflowWrap: 'normal' as const,
	},
	'& th, & td': {
		border: `1px solid ${colors.border}`,
		padding: `${spacing.sm} ${spacing.md}`,
		textAlign: 'left' as const,
		verticalAlign: 'top' as const,
		overflowWrap: 'break-word' as const,
	},
	'& th': {
		fontWeight: typography.fontWeight.semibold,
		backgroundColor: colors.surface,
		whiteSpace: 'nowrap' as const,
	},
	'& [data-markdown-table-compact-last] th:last-child, & [data-markdown-table-compact-last] td:last-child':
		{
			width: 'max-content',
			whiteSpace: 'nowrap' as const,
		},
}

export const proseCss = {
	marginTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	minWidth: 0,
	// `anywhere` (not `break-word`) shrinks min-content, so a grid list item
	// with a long URL in `<code>` cannot stretch the page past the viewport.
	// `body { overflow-x: clip }` would otherwise hide the overflow with no
	// scrollbar. Interactive walkthroughs do not use this object.
	overflowWrap: 'anywhere' as const,
	...markdownTableCss,
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& img': {
		display: 'block',
		maxWidth: '100%',
		height: 'auto',
		margin: '1.15rem 0 0',
		borderRadius: radius.md,
		border: `1px solid ${colors.border}`,
	},
	// The lite player's poster is an `img` inside a 16:9 black stage. The
	// rule above would inset it with margin and `height: auto`, which paints
	// as a black strip along the top of docs `[!WATCH]` embeds.
	'& [data-doc-youtube] img': {
		display: 'block',
		width: '100%',
		maxWidth: 'none',
		height: '100%',
		margin: 0,
		border: 'none',
		borderRadius: 0,
		objectFit: 'cover' as const,
	},
	'& p': {
		margin: '1.15rem 0 0',
		maxWidth: '62ch',
		textWrap: 'pretty' as const,
	},
	// Inline SSR styles are not prose siblings. Keep the first content paragraph flush,
	// without removing spacing when a heading or another content element precedes it.
	'& > p:not(:not(style) ~ *)': {
		marginTop: 0,
	},
	'& p strong': {
		color: colors.text,
	},
	'& h2': {
		margin: 'clamp(2.4rem, 5vw, 3.2rem) 0 0',
		fontSize: 'clamp(1.45rem, 2.6vw, 1.75rem)',
		fontWeight: 720,
		letterSpacing: '-0.018em',
		lineHeight: 1.15,
	},
	'& h2[id], & h3[id], & h4[id], & h5[id], & h6[id]': {
		position: 'relative' as const,
		scrollMarginTop: '5.5rem',
		'&:focus-within [data-heading-anchor]': {
			opacity: 1,
			color: colors.primaryText,
		},
		[hoverMq]: {
			'&:hover [data-heading-anchor]': {
				opacity: 1,
				color: colors.primaryText,
			},
		},
	},
	'& a[data-heading-permalink]': {
		color: 'inherit',
		textDecoration: 'none',
		// Stretch over the heading so clicking the text hits `#slug`
		// without wrapping heading children (which may themselves be links).
		'&::after': {
			content: '""',
			position: 'absolute' as const,
			inset: 0,
		},
		'&:hover, &:focus, &:focus-visible': {
			color: 'inherit',
			textDecoration: 'none',
			outline: 'none',
		},
		'&:focus-visible [data-heading-anchor]': {
			boxShadow: `0 0 0 2px ${colors.primaryText}`,
		},
	},
	'& [data-heading-text]': {
		minWidth: 0,
		'& a': {
			position: 'relative' as const,
			zIndex: 1,
		},
	},
	'& [data-heading-anchor]': {
		// Hang the 44px control to the left of the heading so the text stays
		// aligned with the body; `flex-end` keeps the 16px icon close to it.
		position: 'absolute' as const,
		right: '100%',
		top: '50%',
		transform: 'translateY(-50%)',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		width: '2.75rem',
		height: '2.75rem',
		marginRight: '0.15rem',
		color: colors.textMuted,
		opacity: 0,
		borderRadius: radius.sm,
		transition: 'opacity 120ms ease, color 120ms ease',
		'& svg': {
			width: '1rem',
			height: '1rem',
		},
	},
	'& h2 + p': {
		marginTop: '1rem',
	},
	'& ul, & ol': {
		margin: '1.15rem 0 0',
		paddingLeft: '1.25rem',
		display: 'grid',
		gap: '0.6rem',
		// Grid items default to `min-width: auto` (min-content). Without this,
		// one long token in a list item blows the column out on a phone.
		minWidth: 0,
	},
	'& li': {
		minWidth: 0,
		paddingLeft: '0.25rem',
		textWrap: 'pretty' as const,
		overflowWrap: 'anywhere' as const,
	},
	'& li::marker': {
		color: colors.primaryText,
	},
	'& li strong': {
		color: colors.text,
	},
	// Quoted voices stay quiet: a hairline rule and muted ink, no green.
	'& blockquote': {
		margin: '1.4rem 0 0',
		padding: '0 0 0 1.1rem',
		borderLeft: `2px solid ${colors.border}`,
		color: colors.textMuted,
	},
	'& blockquote p:not(:not(style) ~ *)': {
		marginTop: 0,
	},
	'& code': {
		font: '500 0.92em/1.2 ui-monospace, "SF Mono", Menlo, monospace',
		backgroundColor: colors.surface,
		border: `1px solid ${colors.border}`,
		borderRadius: '6px',
		padding: '0.1em 0.4em',
		// Inline code has to wrap, and the wrap has to affect min-content so
		// a grid `<li>` can shrink. `break-word` does not; `anywhere` does.
		// `& pre code` resets this so fenced blocks keep scrolling.
		overflowWrap: 'anywhere' as const,
	},
	'& pre': {
		margin: '1.4rem 0 0',
		padding: '1rem 1.15rem',
		backgroundColor: colors.surface,
		border: `1px solid ${colors.border}`,
		borderRadius: '10px',
		overflowX: 'auto' as const,
	},
	'& pre code': {
		font: '500 0.88em/1.55 ui-monospace, "SF Mono", Menlo, monospace',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
		whiteSpace: 'pre' as const,
		overflowWrap: 'normal' as const,
	},
}

type SurfaceCardCssOptions = {
	interactive?: boolean
}

export function getSurfaceCardCss(
	options: SurfaceCardCssOptions = {},
): CSSObject {
	return {
		...surfaceCardCss,
		...(options.interactive
			? {
					transition: `border-color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
					[hoverMq]: {
						'&:hover': {
							borderColor: colors.primary,
							transform: 'translateY(-2px)',
						},
					},
					'@media (prefers-reduced-motion: reduce)': {
						transition: `border-color 160ms ${transitions.easeOut}`,
						'&:hover': { transform: 'none' },
					},
				}
			: {}),
	}
}

export const stackedPageCss = {
	display: 'grid',
	gap: spacing.lg,
}

export const layoutMaxWidths = {
	narrow: '48rem',
	content: '64rem',
	extended: '72rem',
	wide: '96rem',
} as const

/**
 * Reading-column width for articles and guides. Page chrome (header, footer,
 * marketing sections) uses `layoutMaxWidths.extended` instead.
 */
export const articleMeasure = '43rem'

/**
 * Horizontal inset every page container carries inside its max-width box.
 * The site header, the footer, and the redesigned sections all use it, so a
 * container that skips it renders wider than the nav above it.
 */
export const pageGutter = 'clamp(1.25rem, 4vw, 2.5rem)'

/**
 * Vertical pieces of the sticky site header. Keep these in sync with
 * `site-header.tsx` (`navCss` padding + `brandCss` minHeight) and the 1px
 * `.site-header` hairline in `styles.css`.
 */
export const siteHeaderNavPaddingBlock = '0.8rem'
export const siteHeaderBrandMinHeight = '44px'
const siteHeaderHairline = '1px'

/**
 * Block size of the sticky site header (`top: 0`). Sticky rails that sit
 * under it use this as their `top` so the rail's natural position at
 * `scrollY=0` equals the sticky offset — otherwise a tall content column
 * engages sticky and nudges the rail down, while a short column leaves it
 * at the natural (higher) spot.
 */
export const siteHeaderHeight = `calc(${siteHeaderNavPaddingBlock} + ${siteHeaderBrandMinHeight} + ${siteHeaderNavPaddingBlock} + ${siteHeaderHairline})`

/**
 * Established viewport top for the first account-rail content (workspace
 * switcher / eyebrow) under the sticky header. Kept as the long-list look;
 * the sticky box itself sticks at `siteHeaderHeight` and
 * `accountRailGapBelowHeader` pads the content down to this line.
 */
const accountRailContentTop = '5rem'

/** Breathing room between the header hairline and the first rail content. */
export const accountRailGapBelowHeader = `calc(${accountRailContentTop} - ${siteHeaderHeight})`

/**
 * Shared shell for every package detail tab (Repo, Files, Settings, …).
 * Same box model as the site header `navCss`: `maxWidth` on the content box
 * with `pageGutter` padding outside it (no `border-box`), so Files keeps the
 * width it already had and lines up with the header. Carries the shirt-pattern
 * whisper so switching tabs does not change background. The app shell leaves
 * these routes unpadded; gutters live here.
 */
export const workspaceTextureCss = {
	...pageHeadCss['&::before'],
	inset: 'auto',
	top: '-3rem',
	insetInline: 0,
	height: '44rem',
	background: `radial-gradient(ellipse 46% 55% at 70% 22%, oklch(from ${colors.text} l c h / 0.025), transparent 72%)`,
}

export const packageDetailPageCss = {
	position: 'relative' as const,
	isolation: 'isolate' as const,
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `${spacing.lg} ${pageGutter} ${spacing['2xl']}`,
	[mq.tablet]: {
		padding: `${spacing.md} ${pageGutter} ${spacing.xl}`,
	},
	'&::before': {
		...workspaceTextureCss,
		insetInline: '-30%',
	},
	'[data-workspace-panel] &::before': { display: 'none' },
}

export const pageHeaderCss = {
	display: 'grid',
	gap: spacing.xs,
}

export const pageEyebrowCss = {
	fontSize: typography.fontSize.xs,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

export const pageTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const pageDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
}

export const cardCss: CSSObject = {
	...surfaceCardCss,
	padding: spacing.lg,
	display: 'grid',
	gap: spacing.md,
}

export const insetCardCss = {
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.borderSubtle}`,
	backgroundColor: colors.background,
	display: 'grid',
	gap: spacing.xs,
}

export const cardTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const descriptionCss = {
	margin: 0,
	color: colors.textMuted,
}

/**
 * Native `<details>` / `<summary>` treatment used by the public FAQ and
 * other in-flow disclosures. Keep new disclosures on this object
 * instead of inventing a second accordion.
 */
export const nativeDisclosureCss = {
	margin: 0,
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
		display: 'grid',
		gap: '0.7rem',
		color: colors.textMuted,
		fontSize: '0.98rem',
		lineHeight: 1.5,
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
	'& p': {
		margin: 0,
		textWrap: 'pretty' as const,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: 600,
		width: 'fit-content',
		fontSize: typography.fontSize.sm,
	},
}

export const fieldCss = {
	display: 'grid',
	gap: '0.45rem',
	minWidth: 0,
}

export const fieldLabelCss = {
	fontSize: '0.92rem',
	fontWeight: 600,
	color: colors.text,
}

/** Label row with a trailing quiet action ("Forgot password?"). */
export const fieldLabelRowCss = {
	display: 'flex',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.md,
}

export const fieldDescriptionCss = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

export const fieldErrorCss = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.error,
}

type ControlSize = 'sm' | 'md'

export type FieldControlStyleOptions = {
	/**
	 * `md` (default, 48px) for forms, `sm` (36px) for toolbars, filters, and
	 * dense rows. Heights line up with the `lg` and `sm` Button sizes.
	 */
	size?: ControlSize
	/**
	 * `canvas` controls sit on a `surface` panel and read as wells in the page
	 * ground color; `surface` (default) is for controls on the canvas.
	 */
	background?: 'canvas' | 'surface'
}

const controlSizes = {
	sm: {
		font: '0.875rem',
		lineHeight: 1.5,
		paddingY: '0.375rem',
		paddingX: '0.625rem',
		squircle: 'xs',
	},
	md: {
		font: '1rem',
		lineHeight: 1.2,
		paddingY: '0.85rem',
		paddingX: '1.05rem',
		squircle: 'lg',
	},
} as const satisfies Record<ControlSize, Record<string, string | number>>

/**
 * The bordered text field look shared by `Input`, `Textarea`, and `Select`.
 * The field draws its own focus ring (green border and soft glow), so the
 * element carries `data-field-ring` to stand down the global outline.
 */
export function getFieldControlCss(options: FieldControlStyleOptions = {}) {
	const size = controlSizes[options.size ?? 'md']
	return {
		font: `400 ${size.font}/${size.lineHeight} ${typography.fontFamilyBody}`,
		color: colors.text,
		backgroundColor:
			options.background === 'canvas' ? colors.background : colors.surface,
		border: `1px solid ${colors.fieldBorder}`,
		...getSquircleCss(size.squircle),
		padding: `${size.paddingY} ${size.paddingX}`,
		minWidth: 0,
		width: '100%',
		maxWidth: '100%',
		boxSizing: 'border-box' as const,
		transition: `border-color 160ms ${transitions.easeOut}`,
		// Text wider than the field is otherwise sliced through a letter; this
		// covers an overlong value as well as an overlong placeholder.
		textOverflow: 'ellipsis',
		'&::placeholder': {
			color: colors.textMuted,
			opacity: 1,
		},
		'&:focus': {
			borderColor: colors.primary,
			boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
		},
		'&[aria-invalid="true"]': {
			borderColor: colors.error,
		},
		'&:disabled': {
			cursor: 'not-allowed',
			opacity: 0.6,
		},
	}
}

export function getTextareaControlCss(options: FieldControlStyleOptions = {}) {
	return {
		...getFieldControlCss(options),
		resize: 'vertical' as const,
		minHeight: '7rem',
	}
}

/** The field look with a small solid caret inset from the right edge. */
export function getSelectControlCss(options: FieldControlStyleOptions = {}) {
	const caretInset = controlSizes[options.size ?? 'md'].paddingX
	return {
		...getFieldControlCss(options),
		appearance: 'none' as const,
		WebkitAppearance: 'none' as const,
		cursor: 'pointer',
		paddingRight: `calc(${caretInset} + 16px)`,
		backgroundImage: 'var(--select-caret)',
		backgroundRepeat: 'no-repeat',
		backgroundPosition: `right ${caretInset} center`,
		backgroundSize: '8px 5px',
	}
}

/** Native checkbox and radio: the theme accent at a touch-friendly size. */
export const choiceControlCss = {
	flex: 'none',
	width: '1.125rem',
	height: '1.125rem',
	margin: 0,
	accentColor: colors.primary,
	cursor: 'pointer',
	'&:disabled': { cursor: 'not-allowed' },
}

/**
 * The inline "working on it" spinner that sits beside a line of status text
 * (connecting an agent, loading the timeline). Decorative — the sentence next
 * to it carries the meaning — so it simply stops under reduced motion.
 */
export const inlineSpinnerCss = {
	flex: 'none',
	width: '1rem',
	height: '1rem',
	boxSizing: 'border-box' as const,
	border: `2px solid ${colors.border}`,
	borderTopColor: colors.primary,
	borderRadius: radius.full,
	'@keyframes inline-spinner-spin': {
		to: { transform: 'rotate(360deg)' },
	},
	'@media (prefers-reduced-motion: no-preference)': {
		animation: 'inline-spinner-spin 0.8s linear infinite',
	},
}

const focusRingCss = {
	outline: `2px solid ${colors.primary}`,
	outlineOffset: '2px',
}

export const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden' as const,
	clip: 'rect(0, 0, 0, 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
}

export const visuallyHiddenUntilFocusedCss = {
	...visuallyHiddenCss,
	'&:focus-visible': {
		...focusRingCss,
		position: 'fixed' as const,
		top: spacing.sm,
		left: spacing.sm,
		zIndex: 1000,
		width: 'auto',
		height: 'auto',
		margin: 0,
		padding: `${spacing.sm} ${spacing.md}`,
		overflow: 'visible' as const,
		clip: 'auto',
		whiteSpace: 'normal' as const,
		border: `1px solid ${colors.primary}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.primaryText,
		fontWeight: typography.fontWeight.semibold,
	},
}

export const listCss = {
	margin: 0,
	paddingLeft: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}

export const detailGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
	gap: spacing.md,
}

export const detailItemCss = {
	display: 'grid',
	gap: spacing.xs,
	alignContent: 'start',
	minWidth: 0,
}

export const detailLabelCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
}

export const detailValueCss = {
	display: 'block',
	maxWidth: '100%',
	minWidth: 0,
	color: colors.text,
	overflowWrap: 'anywhere',
	whiteSpace: 'normal',
}

export const primaryLinkCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}

export const mutedLinkCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}

export function getAlertCardCss(type: 'error' | 'info' = 'info') {
	return {
		margin: 0,
		padding: spacing.md,
		borderRadius: radius.md,
		border: `1px solid ${type === 'error' ? colors.error : colors.primary}`,
		backgroundColor:
			type === 'error'
				? 'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))'
				: colors.primarySoftest,
		color: type === 'error' ? colors.error : colors.text,
		fontSize: typography.fontSize.sm,
	}
}

/**
 * Rounded plate behind uploaded or third-party logos. Always white (and
 * dark ink for `currentColor` marks) so logos that were authored for a
 * light field stay legible in dark mode without per-logo theme variants.
 */
export function getLogoWellCss(
	options: {
		size: string
		radius: string
		borderWidth?: string
	} = { size: '3.2rem', radius: '12px' },
) {
	return {
		display: 'grid',
		placeItems: 'center',
		flex: 'none',
		boxSizing: 'border-box' as const,
		width: options.size,
		height: options.size,
		borderRadius: options.radius,
		border: `${options.borderWidth ?? '1px'} solid ${colors.border}`,
		backgroundColor: colors.logoWell,
		color: colors.logoWellInk,
		overflow: 'hidden' as const,
	}
}

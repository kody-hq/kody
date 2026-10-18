import {
	colors,
	mq,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * Hover styles that move or lift must be gated on a real hover device —
 * touch taps otherwise leave elements stuck in their hover state.
 */
export const hoverMq = '@media (hover: hover) and (pointer: fine)'

type ButtonCssOptions = {
	size?: 'md' | 'lg'
	weight?: keyof typeof typography.fontWeight
	mobileFullWidth?: boolean
}

function getBaseButtonCss(options: ButtonCssOptions = {}) {
	const size = options.size ?? 'md'
	const weight = options.weight ?? 'medium'

	return {
		padding: `${spacing.sm} ${size === 'lg' ? spacing.lg : spacing.md}`,
		borderRadius: radius.full,
		fontSize: typography.fontSize.base,
		fontWeight: typography.fontWeight[weight],
		cursor: 'pointer',
		transition: `transform ${transitions.fast}, background-color ${transitions.normal}, border-color ${transitions.normal}, opacity ${transitions.normal}`,
		'&:disabled': {
			cursor: 'not-allowed',
			opacity: 0.7,
		},
		...(options.mobileFullWidth
			? {
					[mq.mobile]: {
						width: '100%',
					},
				}
			: {}),
	}
}

/**
 * Motion kill for buttons. Declared last in each variant literal so it wins
 * the cascade over both the press scale and the hover lift.
 */
const buttonReducedMotionCss = {
	'@media (prefers-reduced-motion: reduce)': {
		// Keep the color/opacity fades — reduced motion drops movement,
		// not feedback.
		transition: `background-color ${transitions.normal}, border-color ${transitions.normal}, color ${transitions.normal}, opacity ${transitions.normal}, box-shadow ${transitions.normal}`,
		'&:not(:disabled):hover': { transform: 'none' },
		'&:not(:disabled):active': { transform: 'none' },
	},
}

export function getPrimaryButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: 'none',
		backgroundColor: colors.primary,
		color: colors.onPrimary,
		// Press feedback works everywhere, including touch.
		'&:not(:disabled):active': {
			backgroundColor: colors.primaryActive,
			transform: 'scale(0.97)',
		},
		[hoverMq]: {
			'&:not(:disabled):hover': {
				backgroundColor: colors.primaryHover,
				transform: 'translateY(-1px)',
			},
			// Re-declared inside the media block so the press scale beats the
			// hover lift while both apply.
			'&:not(:disabled):active': {
				transform: 'scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

export function getSecondaryButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: `1px solid ${colors.border}`,
		backgroundColor: 'transparent',
		color: colors.text,
		'&:not(:disabled):active': {
			backgroundColor: colors.primarySoft,
			transform: 'scale(0.97)',
		},
		[hoverMq]: {
			'&:not(:disabled):hover': {
				backgroundColor: colors.primarySoftest,
				borderColor: colors.primary,
				transform: 'translateY(-1px)',
			},
			'&:not(:disabled):active': {
				transform: 'scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

export function getDangerButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: 'none',
		backgroundColor: colors.danger,
		color: colors.onDanger,
		'&:not(:disabled):active': {
			backgroundColor: colors.danger,
			transform: 'scale(0.97)',
		},
		[hoverMq]: {
			'&:not(:disabled):hover': {
				backgroundColor: colors.dangerHover,
				transform: 'translateY(-1px)',
			},
			'&:not(:disabled):active': {
				transform: 'scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

type PillButtonCssOptions = {
	mobileFullWidth?: boolean
	/**
	 * `sm` is the prototype's `.account-actions .button` — the size the
	 * in-page actions of the account and admin areas use, so their rows stay
	 * proportionate to body copy. `md` (default) is the marketing CTA size.
	 */
	size?: 'md' | 'sm'
}

function getBasePillButtonCss(options: PillButtonCssOptions = {}) {
	const small = options.size === 'sm'
	return {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '0.5rem',
		font: `650 ${small ? '0.95rem' : '1rem'}/1 ${typography.fontFamilyDisplay}`,
		borderRadius: radius.full,
		padding: small ? '0.75rem 1.3rem' : '0.95rem 1.7rem',
		cursor: 'pointer',
		textDecoration: 'none',
		whiteSpace: 'nowrap' as const,
		transition: `background-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
		'&:disabled': {
			cursor: 'not-allowed',
			opacity: 0.7,
		},
		'&:not(:disabled):active': {
			transform: 'translateY(0) scale(0.97)',
		},
		...(options.mobileFullWidth
			? {
					[mq.mobile]: {
						width: '100%',
					},
				}
			: {}),
	}
}

export function getPillButtonCss(options?: PillButtonCssOptions) {
	return {
		...getBasePillButtonCss(options),
		border: 'none',
		backgroundColor: colors.primary,
		color: colors.onPrimary,
		[hoverMq]: {
			'&:not(:disabled):hover': {
				backgroundColor: colors.primaryHover,
				color: colors.onPrimary,
				transform: 'translateY(-1px)',
				boxShadow: `0 6px 20px -8px oklch(from ${colors.primary} l c h / 0.6)`,
			},
			'&:not(:disabled):active': {
				transform: 'translateY(0) scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

export function getGhostButtonCss(options?: PillButtonCssOptions) {
	return {
		...getBasePillButtonCss(options),
		border: 'none',
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
			'&:not(:disabled):active': {
				transform: 'translateY(0) scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

/**
 * Destructive action in the redesign's pill vocabulary — the ghost button's
 * quiet shape carrying the danger color. Deliberately not a solid red fill:
 * these sit inline in account and admin lists next to ordinary actions, and a
 * filled pill would shout for attention the action has not earned yet. The
 * ring and the color say "destructive"; hover commits to it.
 */
export function getDangerPillCss(options?: PillButtonCssOptions) {
	return {
		...getBasePillButtonCss(options),
		border: 'none',
		backgroundColor: 'transparent',
		color: colors.danger,
		boxShadow: `inset 0 0 0 1.5px oklch(from ${colors.danger} l c h / 0.45)`,
		[hoverMq]: {
			'&:not(:disabled):hover': {
				backgroundColor: `oklch(from ${colors.danger} l c h / 0.12)`,
				transform: 'translateY(-1px)',
				boxShadow: `inset 0 0 0 1.5px ${colors.danger}`,
			},
			'&:not(:disabled):active': {
				transform: 'translateY(0) scale(0.97)',
			},
		},
		...buttonReducedMotionCss,
	}
}

/**
 * Control that sits beside a value rather than in an action row — the copy
 * button of an `IdValue`. Deliberately not a pill: at this size the display
 * face and the full radius read as a second value, and the pill's `sm`
 * padding would take most of a metadata column from the id it belongs to.
 * It borrows the chrome of the code chip next to it instead.
 */
export function getChipButtonCss() {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		flex: 'none',
		padding: '0.18rem 0.4rem',
		borderRadius: radius.sm,
		border: `1px solid ${colors.border}`,
		backgroundColor: 'transparent',
		color: colors.textMuted,
		fontFamily: typography.fontFamily,
		fontSize: typography.fontSize.xs,
		fontWeight: typography.fontWeight.semibold,
		lineHeight: 1.4,
		cursor: 'pointer',
		whiteSpace: 'nowrap' as const,
		transition: `color 160ms ${transitions.easeOut}, border-color 160ms ${transitions.easeOut}`,
		[hoverMq]: {
			'&:not(:disabled):hover': {
				color: colors.primaryText,
				borderColor: colors.primary,
			},
		},
		'&:not(:disabled):active': {
			transform: 'scale(0.97)',
		},
		...buttonReducedMotionCss,
	}
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

export function getSurfaceCardCss(options: SurfaceCardCssOptions = {}) {
	return {
		backgroundColor: colors.surface,
		border: `1.5px solid ${colors.border}`,
		borderRadius: radius.card,
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
export const siteHeaderHairline = '1px'

/**
 * Block size of the sticky site header (`top: 0`). Sticky rails that sit
 * under it use this as their `top` so the rail's natural position at
 * `scrollY=0` equals the sticky offset — otherwise a tall content column
 * engages sticky and nudges the rail down, while a short column leaves it
 * at the natural (higher) spot.
 */
export const siteHeaderHeight = `calc(${siteHeaderNavPaddingBlock} + ${siteHeaderBrandMinHeight} + ${siteHeaderNavPaddingBlock} + ${siteHeaderHairline})`

/**
 * Shared shell for every package detail tab (Repo, Files, Settings, …).
 * Same box model as the site header `navCss`: `maxWidth` on the content box
 * with `pageGutter` padding outside it (no `border-box`), so Files keeps the
 * width it already had and lines up with the header. Carries the shirt-pattern
 * whisper so switching tabs does not change background. The app shell leaves
 * these routes unpadded; gutters live here.
 */
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
		...pageHeadCss['&::before'],
		inset: 'auto',
		top: '-3rem',
		left: '-30%',
		right: '-30%',
		height: '44rem',
		background: `radial-gradient(ellipse 46% 55% at 70% 22%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
}

/**
 * Widen a block past `articleMeasure` when the viewport has room, staying
 * centered on the article and inside the same gutters as the site header.
 *
 * Spread into the css object of a child of a `maxWidth: articleMeasure`
 * article that uses `pageGutter` for horizontal padding. On a phone it is a
 * no-op; on a wide screen it grows up to `maxWidth` (default
 * `layoutMaxWidths.extended`).
 */
export function getArticleBreakoutCss(options?: { maxWidth?: string }) {
	const maxWidth = options?.maxWidth ?? layoutMaxWidths.extended
	return {
		boxSizing: 'border-box' as const,
		width: `min(${maxWidth}, calc(100vw - 2 * ${pageGutter}))`,
		maxWidth: 'none' as const,
		marginInline: `calc(50% - min(${maxWidth} / 2, 50vw - ${pageGutter}))`,
	}
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

export const cardCss = {
	padding: spacing.lg,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.sm,
	display: 'grid',
	gap: spacing.md,
}

export const insetCardCss = {
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
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
	gap: spacing.xs,
	minWidth: 0,
}

export const fieldLabelCss = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
}

export const inputCss = {
	width: '100%',
	minWidth: 0,
	maxWidth: '100%',
	padding: spacing.sm,
	borderRadius: radius.md,
	border: `1px solid ${colors.fieldBorder}`,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.base,
	fontFamily: typography.fontFamily,
	boxSizing: 'border-box' as const,
}

/** Label-over-input stack from the redesign's `.field` (login prototype). */
export const authFieldCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.45rem',
}

export const authFieldLabelCss = {
	fontSize: '0.92rem',
	fontWeight: 600,
	color: colors.text,
}

/** Label row with a trailing quiet link ("Forgot password?"). */
export const authFieldLabelRowCss = {
	display: 'flex',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.md,
}

type AuthInputCssOptions = {
	/**
	 * `canvas` inputs sit on a `surface` panel and read as wells in the page
	 * ground color (the login panel); `surface` is the default when the input
	 * sits directly on the canvas.
	 */
	background?: 'canvas' | 'surface'
}

/**
 * Individually bordered input from the redesign: the focus ring is drawn on
 * the field itself (green border + soft glow). Markup contract: put
 * `data-field-ring` on the input so the unlayered global `:focus-visible`
 * outline in `public/styles.css` stands down — otherwise it double-rings and
 * forces its 4px radius onto the 12px field.
 */
export function getAuthInputCss(options: AuthInputCssOptions = {}) {
	return {
		font: `400 1rem/1.2 ${typography.fontFamilyBody}`,
		color: colors.text,
		backgroundColor:
			options.background === 'canvas' ? colors.background : colors.surface,
		border: `1.5px solid ${colors.fieldBorder}`,
		borderRadius: '12px',
		padding: '0.85rem 1.05rem',
		minWidth: 0,
		width: '100%',
		boxSizing: 'border-box' as const,
		transition: `border-color 160ms ${transitions.easeOut}`,
		// Text wider than the field is otherwise sliced through a letter. This
		// has to sit on the input, not on `::placeholder` — `text-overflow` is
		// not one of the properties that pseudo-element accepts — and it covers
		// an overlong value as well as an overlong placeholder. Fields wide
		// enough for their text never see the ellipsis.
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
	}
}

/**
 * `<select>` in the redesign's field vocabulary: the same box as
 * `getAuthInputCss` with the platform chevron replaced by our own, so every
 * dropdown in the app reads identically instead of inheriting whatever the OS
 * draws. The chevron is a background image inset by the field's own padding —
 * the text gets matching room on the right so a long option never runs under
 * it. A background image cannot read `currentColor`, so the chevron's stroke
 * is baked into a themed `--select-chevron` token (see `public/styles.css`)
 * rather than picked as one compromise gray for both themes.
 *
 * Markup contract: same as `getAuthInputCss` — put `data-field-ring` on the
 * element so the global `:focus-visible` outline stands down for the field's
 * own green ring.
 */
export function getSelectCss(options: AuthInputCssOptions = {}) {
	const chevronInset = '1.05rem'
	return {
		...getAuthInputCss(options),
		appearance: 'none' as const,
		WebkitAppearance: 'none' as const,
		cursor: 'pointer',
		paddingRight: `calc(${chevronInset} * 2 + 16px)`,
		backgroundImage: 'var(--select-chevron)',
		backgroundRepeat: 'no-repeat',
		backgroundPosition: `right ${chevronInset} center`,
		backgroundSize: '16px 16px',
	}
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

export const textareaCss = {
	...inputCss,
	resize: 'vertical' as const,
	minHeight: '7rem',
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

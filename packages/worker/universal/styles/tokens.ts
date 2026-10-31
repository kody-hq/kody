// Color tokens
export const colors = {
	primary: 'var(--color-primary)',
	primaryHover: 'var(--color-primary-hover)',
	primaryActive: 'var(--color-primary-active)',
	primaryText: 'var(--color-primary-text)',
	primarySoftest: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
	primarySoft: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
	primarySoftStrong:
		'color-mix(in srgb, var(--color-primary) 15%, transparent)',
	onPrimary: 'var(--color-on-primary)',
	background: 'var(--color-background)',
	surface: 'var(--color-surface)',
	text: 'var(--color-text)',
	textMuted: 'var(--color-text-muted)',
	border: 'var(--color-border)',
	borderSubtle:
		'color-mix(in srgb, var(--color-border) 30%, var(--color-surface))',
	fieldBorder: 'var(--color-field-border)',
	danger: 'var(--color-danger)',
	dangerHover: 'var(--color-danger-hover)',
	onDanger: 'var(--color-on-danger)',
	warning: 'var(--color-warning)',
	warningText: 'var(--color-warning-text)',
	error: 'var(--color-danger)',
	errorHover: 'var(--color-danger-hover)',
	/**
	 * Fixed white plate behind uploaded / third-party logos so dark marks
	 * (GitHub, monochrome SVGs) stay readable in dark mode and colorful
	 * marks stay consistent across themes. Not a theme variable on purpose.
	 */
	logoWell: '#ffffff',
	/** Ink for `currentColor` marks sitting on {@link colors.logoWell}. */
	logoWellInk: '#111111',
	/**
	 * Ink on a fixed dark scrim (YouTube play badge, watch overlay close).
	 * Theme `onPrimary` is near-black in dark mode and would vanish on
	 * `rgba(0, 0, 0, 0.72)`. Same white as light-mode `--color-on-primary`.
	 */
	onScrim: 'oklch(1 0 0)',
} as const

// Typography tokens
export const typography = {
	fontFamily: 'var(--font-family)',
	fontFamilyDisplay: 'var(--font-display)',
	fontFamilyBody: 'var(--font-body)',
	fontFamilyMono: 'var(--font-mono)',
	fontSize: {
		xs: 'var(--font-size-xs)',
		sm: 'var(--font-size-sm)',
		base: 'var(--font-size-base)',
		lg: 'var(--font-size-lg)',
		xl: 'var(--font-size-xl)',
		'2xl': 'var(--font-size-2xl)',
	} as const,
	fontWeight: {
		normal: 'var(--font-weight-normal)',
		medium: 'var(--font-weight-medium)',
		semibold: 'var(--font-weight-semibold)',
		bold: 'var(--font-weight-bold)',
	} as const,
} as const

// Spacing tokens
export const spacing = {
	xs: 'var(--spacing-xs)',
	sm: 'var(--spacing-sm)',
	md: 'var(--spacing-md)',
	lg: 'var(--spacing-lg)',
	xl: 'var(--spacing-xl)',
	'2xl': 'var(--spacing-2xl)',
} as const

// Border radius tokens
export const radius = {
	sm: 'var(--radius-sm)',
	md: 'var(--radius-md)',
	lg: 'var(--radius-lg)',
	xl: 'var(--radius-xl)',
	card: 'var(--radius-card)',
	full: 'var(--radius-full)',
} as const

// Shadow tokens
export const shadows = {
	sm: 'var(--shadow-sm)',
	md: 'var(--shadow-md)',
} as const

// Transition tokens
export const transitions = {
	fast: 'var(--transition-fast)',
	normal: 'var(--transition-normal)',
	easeOut: 'var(--ease-out)',
	// Literal twin of --ease-out (public/styles.css) for WAAPI call sites,
	// which cannot resolve CSS custom properties in easing strings.
	easeOutValue: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const

// Breakpoints for CSS-in-JS media queries
export const breakpoints = {
	mobile: '640px',
	tablet: '1024px',
} as const

export const mq = {
	mobile: `@media (max-width: ${breakpoints.mobile})`,
	tablet: `@media (max-width: ${breakpoints.tablet})`,
} as const

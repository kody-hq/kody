/**
 * Chart series palette. Mid-lightness hues chosen to stay legible on both
 * the light and dark surface colors.
 */
export const chartColor = {
	blue: '#3b82f6',
	emerald: '#10b981',
	amber: '#f59e0b',
	violet: '#8b5cf6',
	rose: '#f43f5e',
	cyan: '#06b6d4',
	lime: '#84cc16',
	fuchsia: '#d946ef',
	teal: '#14b8a6',
	orange: '#f97316',
} as const

export const chartEmptyFill =
	'color-mix(in srgb, var(--color-border) 45%, transparent)'

export const chartScrollerCss = {
	minWidth: 0,
	maxWidth: '100%',
	overflowX: 'auto' as const,
	WebkitOverflowScrolling: 'touch' as const,
} as const

// Start time series at the newest values. The chart content restores ltr.
export const chartScrollerNewestFirstCss = {
	...chartScrollerCss,
	direction: 'rtl' as const,
} as const

export function softColor(color: string, percent: number) {
	return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

const compactFormatter = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})

const integerFormatter = new Intl.NumberFormat('en-US')

export function formatCompactNumber(value: number) {
	return compactFormatter.format(value)
}

export function formatIntegerNumber(value: number) {
	return integerFormatter.format(value)
}

export function formatPercentShare(fraction: number) {
	if (!Number.isFinite(fraction)) return '0%'
	const percent = fraction * 100
	if (percent > 0 && percent < 1) return '<1%'
	return `${Math.round(percent)}%`
}

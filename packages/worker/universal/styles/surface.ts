import { type CSSObject } from '@emotion/react'
import { colors } from './tokens.ts'

/** A small elevation step for surfaces inside another card. */
export const nestedSurfaceDarkCss: CSSObject = {
	background: `color-mix(in srgb, ${colors.surface} 94%, ${colors.text})`,
	borderColor: `color-mix(in srgb, ${colors.border} 65%, ${colors.surface})`,
}

/** Shared card material, derived entirely from the active theme. */
export const surfaceCardCss: CSSObject = {
	border: `1px solid ${colors.borderSubtle}`,
	borderRadius: '1rem',
	backgroundColor: colors.surface,
	backgroundImage: `linear-gradient(145deg, transparent, color-mix(in srgb, ${colors.background} 15%, transparent))`,
	boxShadow: `inset 0 1px 0 color-mix(in srgb, ${colors.surface} 80%, transparent), 0 8px 32px color-mix(in srgb, ${colors.text} 4%, transparent)`,
	'@media (prefers-color-scheme: dark)': {
		boxShadow: `inset 0 1px 0 color-mix(in srgb, ${colors.text} 5%, transparent), 0 8px 32px color-mix(in srgb, ${colors.background} 40%, transparent)`,
	},
}

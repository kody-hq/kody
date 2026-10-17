/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { type ReactNode } from 'react'
import { iconGlyphs, type IconName } from './icon-glyphs.tsx'

export type { IconName } from './icon-glyphs.tsx'

/**
 * Iconic draws in a 24×24 viewBox with ~4.75 units of padding so the 1.5px
 * stroke never clips. That reads small next to type. Crop to the glyph the
 * same way `provider-icons` crops padded brand marks. Glyphs carry their own
 * stroke and fill — do not stamp stroke on the `<svg>` or fill-only marks
 * inherit it and bloat.
 */
const iconicGlyphViewBox = '3.75 3.75 16.5 16.5'

const defaultIconSize = '1em'

export function renderIcon(
	name: IconName,
	options: { size?: string; title?: string } = {},
): ReactNode {
	const size = options.size ?? defaultIconSize
	const labelled = Boolean(options.title)
	return (
		<svg
			data-icon={name}
			viewBox={iconicGlyphViewBox}
			width={size}
			height={size}
			fill="none"
			aria-hidden={labelled ? undefined : 'true'}
			role={labelled ? 'img' : undefined}
			aria-label={options.title}
			focusable={false}
		>
			{iconGlyphs[name]()}
		</svg>
	)
}

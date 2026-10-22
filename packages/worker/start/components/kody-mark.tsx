/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	kodyMarkAspectRatio,
	kodyMarkPathD,
	kodyMarkPathTransform,
	kodyMarkViewBox,
} from '../brand/kody-mark-path.ts'

export type KodyMarkProps = {
	/** Rendered height in CSS pixels; width follows the natural aspect ratio. */
	size?: number
	/** Accessible name. Empty string keeps the mark decorative when a nearby label exists. */
	title?: string
	className?: string
	css?: CSSObject
}

/**
 * Inline Kody mark. Uses `currentColor` so light mode paints black ink and
 * dark mode paints white when the parent sets the theme foreground color.
 */
export function KodyMark({
	size = 34,
	title = '',
	className,
	css: cssProp,
}: KodyMarkProps) {
	const width = Math.round(size * kodyMarkAspectRatio)
	const labelled = title.trim().length > 0
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={kodyMarkViewBox}
			width={width}
			height={size}
			className={className}
			css={[{ display: 'block', flexShrink: 0, color: 'inherit' }, cssProp]}
			role={labelled ? 'img' : undefined}
			aria-hidden={labelled ? undefined : true}
			aria-label={labelled ? title : undefined}
			focusable="false"
		>
			{labelled ? <title>{title}</title> : null}
			<path
				fill="currentColor"
				fillRule="evenodd"
				transform={kodyMarkPathTransform}
				d={kodyMarkPathD}
			/>
		</svg>
	)
}

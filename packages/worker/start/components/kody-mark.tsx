/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	kodyMarkAspectRatio,
	kodyMarkOutlinedLeftEyePathD,
	kodyMarkOutlinedNosePathD,
	kodyMarkOutlinedRightEyePathD,
	kodyMarkOutlinedRingPathD,
	kodyMarkPathD,
	kodyMarkPathTransform,
	kodyMarkViewBox,
} from '../brand/kody-mark-path.ts'

type KodyMarkVariant = 'auto' | 'solid' | 'outlined'

export type KodyMarkProps = {
	/** Rendered height in CSS pixels; width follows the natural aspect ratio. */
	size?: number
	/**
	 * `auto` (default): outlined line-art in light color scheme, solid fill in
	 * dark. `outlined` / `solid` force one treatment (for side-by-side previews).
	 */
	variant?: KodyMarkVariant
	/** Accessible name. Empty string keeps the mark decorative when a nearby label exists. */
	title?: string
	className?: string
	css?: CSSObject
}

/**
 * Inline Kody mark. Light mode uses the outlined filled-path treatment; dark
 * mode uses the solid fill. Both share the same viewBox and silhouette
 * footprint so theme swaps do not shift layout. Ink follows `currentColor`.
 *
 * Theme switching uses an SVG `<style>` media query (same approach as
 * `favicon.svg`) so `prefers-color-scheme` applies reliably inside SVG.
 */
export function KodyMark({
	size = 34,
	variant = 'auto',
	title = '',
	className,
	css: cssProp,
}: KodyMarkProps) {
	const width = Math.round(size * kodyMarkAspectRatio)
	const labelled = title.trim().length > 0
	// Every `auto` mark emits the same rules, so shared class names are safe and
	// keep SSR/client markup identical when a route boundary re-renders.
	const outlinedClass = 'kody-mark-outlined'
	const solidClass = 'kody-mark-solid'
	const showOutlined = variant === 'outlined' || variant === 'auto'
	const showSolid = variant === 'solid' || variant === 'auto'

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
			{variant === 'auto' ? (
				<style>{`.${outlinedClass}{display:inline}.${solidClass}{display:none}@media (prefers-color-scheme: dark){.${outlinedClass}{display:none}.${solidClass}{display:inline}}`}</style>
			) : null}
			{showOutlined ? (
				<g className={variant === 'auto' ? outlinedClass : undefined}>
					<path
						fill="currentColor"
						fillRule="evenodd"
						transform={kodyMarkPathTransform}
						d={kodyMarkOutlinedRingPathD}
					/>
					<path
						fill="currentColor"
						transform={kodyMarkPathTransform}
						d={kodyMarkOutlinedLeftEyePathD}
					/>
					<path
						fill="currentColor"
						transform={kodyMarkPathTransform}
						d={kodyMarkOutlinedRightEyePathD}
					/>
					<path
						fill="currentColor"
						transform={kodyMarkPathTransform}
						d={kodyMarkOutlinedNosePathD}
					/>
				</g>
			) : null}
			{showSolid ? (
				<path
					className={variant === 'auto' ? solidClass : undefined}
					fill="currentColor"
					fillRule="evenodd"
					transform={kodyMarkPathTransform}
					d={kodyMarkPathD}
				/>
			) : null}
		</svg>
	)
}

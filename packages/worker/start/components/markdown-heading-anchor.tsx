/** @jsxImportSource @emotion/react */

import { type ReactNode } from 'react'
import { renderIcon } from './icon.tsx'

/** Decorative link icon for prose heading permalinks. */
function renderHeadingAnchorIcon() {
	return renderIcon('link', { size: '16' })
}

const headingPermalinkAriaLabel = 'Link to this section'

/**
 * Section permalink that sits beside heading text (not around it) so an
 * inline markdown link in the heading cannot nest inside this `<a>`.
 * `proseCss` stretches the control over the heading and hangs the icon.
 * The heading's `aria-label` owns the title; this control uses a generic name
 * so screen readers do not announce the title twice.
 */
export function renderMarkdownHeadingAnchor(
	key: number,
	headingId: string,
): ReactNode {
	return (
		<a
			key={`anchor-${key}`}
			href={`#${headingId}`}
			data-heading-permalink=""
			aria-label={headingPermalinkAriaLabel}
		>
			<span data-heading-anchor="" aria-hidden="true">
				{renderHeadingAnchorIcon()}
			</span>
		</a>
	)
}

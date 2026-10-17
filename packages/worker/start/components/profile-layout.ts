import { type CSSObject } from '@emotion/react'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

export const profilePageCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding: `clamp(2rem, 5vw, 3.5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
} satisfies CSSObject

export const profileLayoutCss = {
	display: 'grid',
	gap: 'clamp(1.75rem, 4vw, 3rem)',
	alignItems: 'start',
	'@media (min-width: 821px)': {
		gridTemplateColumns: '17.5rem minmax(0, 1fr)',
		gap: '2.75rem',
	},
} satisfies CSSObject

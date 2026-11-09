import type { CSSObject } from '@emotion/react'
import { colors, typography } from '#universal/styles/tokens.ts'

// The document rhythm belongs to the content, not its renderer or edit state.
export const workspaceProse = {
	width: 840,
	body: {
		fontSize: typography.fontSize.sm,
		lineHeight: 1.65,
		overflowWrap: 'anywhere',
	},
	text: {
		boxSizing: 'border-box',
		margin: 0,
		padding: '2px 0',
		minHeight: 'calc(1lh + 4px)',
	},
	block: { marginBottom: 4 },
	heading: {
		fontFamily: 'inherit',
		fontSize: '1.45rem',
		fontWeight: 660,
		lineHeight: 1.3,
		letterSpacing: '-0.02em',
		marginTop: 14,
	},
	quote: {
		borderInlineStart: `3px solid ${colors.border}`,
		paddingInlineStart: 12,
		color: colors.textMuted,
	},
	code: {
		fontFamily: typography.fontFamilyMono,
		background: `color-mix(in srgb, ${colors.text} 5%, transparent)`,
		padding: '10px 12px',
		borderRadius: 6,
	},
} satisfies Record<string, number | CSSObject>

export const workspaceMarkdownCss: CSSObject = {
	...workspaceProse.body,
	'& p, & li': { ...workspaceProse.text, ...workspaceProse.block },
	'& h2, & h3, & h4, & h5, & h6': {
		...workspaceProse.text,
		...workspaceProse.block,
		...workspaceProse.heading,
	},
	'& h3': { fontSize: '1.25rem' },
	'& h4, & h5, & h6': { fontSize: '1.1rem' },
	'& ul, & ol': { margin: 0, paddingInlineStart: 24 },
	'& li > p': { padding: 0, margin: 0, minHeight: 0 },
	'& blockquote': {
		...workspaceProse.text,
		...workspaceProse.block,
		...workspaceProse.quote,
		paddingBlock: 0,
	},
	'& blockquote > :last-child': { marginBottom: 0 },
	'& pre': {
		...workspaceProse.block,
		...workspaceProse.code,
		marginTop: 0,
		whiteSpace: 'pre-wrap',
	},
	'& code': { fontFamily: typography.fontFamilyMono, fontSize: '0.9em' },
	'& pre code': { fontSize: 'inherit' },
	'& hr': {
		border: 0,
		borderTop: `1px solid ${colors.border}`,
		margin: '14px 0',
	},
	'& table': { borderCollapse: 'collapse', width: '100%', marginBlock: 4 },
	'& th, & td': {
		border: `1px solid ${colors.border}`,
		padding: '6px 10px',
		textAlign: 'start',
	},
	'& a': { color: colors.primary, textUnderlineOffset: 3 },
}

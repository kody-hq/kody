/** @jsxImportSource @emotion/react */
import type { ComponentProps } from 'react'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import { SiteLink } from './site-link.tsx'

export type TextLinkTone = 'primary' | 'muted'

export type TextLinkProps = ComponentProps<typeof SiteLink> & {
	tone?: TextLinkTone
}

const baseCss = {
	textDecoration: 'none',
	borderRadius: radius.sm,
	'&:hover': { textDecoration: 'underline' },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const toneCss = {
	primary: {
		color: colors.primaryText,
		fontWeight: typography.fontWeight.medium,
	},
	muted: {
		color: colors.textMuted,
		fontSize: typography.fontSize.sm,
	},
} satisfies Record<TextLinkTone, object>

/**
 * An inline text link. Routes through `SiteLink`, so app paths navigate
 * client side and everything else is a plain anchor.
 */
export function TextLink({ tone = 'primary', ...props }: TextLinkProps) {
	return <SiteLink {...props} css={[baseCss, toneCss[tone]]} />
}

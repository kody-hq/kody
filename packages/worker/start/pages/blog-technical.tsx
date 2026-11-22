/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { ComponentProps } from 'react'
import { routes } from '#universal/routes.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'

/**
 * The `technical` category's look: monospace headings, a faint green
 * graph-paper grid, and a `~/blog/technical` breadcrumb. Applied only to the
 * technical archive and technical posts; site chrome and other categories
 * keep the editorial look.
 */
const TECHNICAL_BLOG_CATEGORY = 'technical'

export function isTechnicalBlogCategory(slug: string) {
	return slug === TECHNICAL_BLOG_CATEGORY
}

const gridLine = (percent: number) =>
	`color-mix(in srgb, ${colors.primary} ${percent}%, transparent)`

export const blogTechnicalThemeCss = {
	position: 'relative' as const,
	isolation: 'isolate' as const,
	// Full-bleed paper behind the reading column; `body` clips overflow-x.
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -2,
		top: 0,
		bottom: 0,
		left: 'calc(50% - 50vw)',
		right: 'calc(50% - 50vw)',
		pointerEvents: 'none' as const,
		backgroundImage: [
			`linear-gradient(${gridLine(14)} 1px, transparent 1px)`,
			`linear-gradient(90deg, ${gridLine(14)} 1px, transparent 1px)`,
			`linear-gradient(${gridLine(7)} 1px, transparent 1px)`,
			`linear-gradient(90deg, ${gridLine(7)} 1px, transparent 1px)`,
		].join(', '),
		backgroundSize: '120px 120px, 120px 120px, 24px 24px, 24px 24px',
		backgroundPosition: 'center top',
		maskImage:
			'linear-gradient(to bottom, transparent, #000 6rem, #000 calc(100% - 10rem), transparent)',
	},
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyMono,
		letterSpacing: '-0.01em',
	},
	// Keep the grid out from behind table text.
	'& td': {
		backgroundColor: colors.background,
	},
	'& header h1': {
		fontSize: 'clamp(1.75rem, 4.4vw, 2.5rem)',
		lineHeight: 1.15,
	},
} satisfies CSSObject

/** Active-tab accent for the technical category in `BlogCategoryNav`. */
export const blogTechnicalTabCss = {
	'&[aria-current="page"]': {
		color: colors.primaryText,
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.9rem',
		borderBottomColor: colors.primaryText,
	},
} satisfies CSSObject

/** `~/blog/technical`: links up to the blog and, from a post, the archive. */
export function BlogTechnicalBreadcrumb({
	current,
	...props
}: { current: 'archive' | 'post' } & ComponentProps<'nav'>) {
	return (
		<nav aria-label="Breadcrumb" {...props} css={breadcrumbCss}>
			<SiteLink href={routes.blog.href()}>~/blog</SiteLink>
			<span aria-hidden="true">/</span>
			{current === 'post' ? (
				<SiteLink
					href={routes.blogCategory.href({
						category: TECHNICAL_BLOG_CATEGORY,
					})}
				>
					technical
				</SiteLink>
			) : (
				<span aria-current="page">technical</span>
			)}
		</nav>
	)
}

const breadcrumbCss = {
	display: 'inline-flex',
	alignItems: 'baseline',
	gap: '0.15rem',
	fontFamily: typography.fontFamilyMono,
	fontSize: '0.9rem',
	fontWeight: 600,
	color: colors.textMuted,
	'& a': {
		color: colors.primaryText,
		textDecoration: 'none',
	},
	'& a:hover': {
		color: colors.text,
		textDecoration: 'underline',
		textUnderlineOffset: '3px',
	},
	'& [aria-current="page"]': {
		color: colors.text,
	},
} satisfies CSSObject

/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import { formatBlogPostDate } from '#universal/blog-display.ts'
import { getBlogCategory } from '#universal/blog-taxonomy.ts'
import type {
	BlogCategoryCountLoaderData,
	BlogPostSummaryLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { pageHeadCss } from '#universal/styles/style-primitives.ts'
import { revealRef } from '../components/reveal.ts'
import { SiteLink } from '../components/site-link.tsx'

export function blogCategoryLabel(slug: string) {
	return getBlogCategory(slug)?.label ?? slug
}

/** "Essays · September 1, 2026 · 6 min read" */
export function blogPostMetaText(
	post: Pick<BlogPostSummaryLoaderData, 'category' | 'date' | 'readingMinutes'>,
	options: { category?: boolean } = {},
) {
	return [
		options.category === false ? null : blogCategoryLabel(post.category),
		formatBlogPostDate(post.date),
		`${post.readingMinutes} min read`,
	]
		.filter(Boolean)
		.join(' · ')
}

/** Underline tabs across the blog's fixed categories (`all` is the index). */
export function BlogCategoryNav({
	categories,
	active,
}: {
	categories: ReadonlyArray<BlogCategoryCountLoaderData>
	active: string
}) {
	return (
		<nav aria-label="Blog categories" css={categoryNavCss}>
			<SiteLink
				href={routes.blog.href()}
				aria-current={active === 'all' ? 'page' : undefined}
				css={categoryTabCss}
			>
				All
			</SiteLink>
			{categories.map((category) => (
				<SiteLink
					key={category.slug}
					href={routes.blogCategory.href({ category: category.slug })}
					aria-current={active === category.slug ? 'page' : undefined}
					css={categoryTabCss}
				>
					{category.label}
					<span css={categoryCountCss}>{category.count}</span>
				</SiteLink>
			))}
		</nav>
	)
}

export function BlogPostList({
	posts,
	showCategory = true,
	eyebrow,
}: {
	posts: ReadonlyArray<BlogPostSummaryLoaderData>
	showCategory?: boolean
	/** Replaces the category in the meta line, e.g. "Part 3". */
	eyebrow?: (post: BlogPostSummaryLoaderData, index: number) => string
}) {
	return (
		<ul css={postListCss}>
			{posts.map((post, index) => (
				<li
					key={post.slug}
					css={postItemCss}
					ref={revealRef(Math.min(index, 3) * 60, 'reveal-card')}
				>
					<SiteLink
						href={routes.blogPost.href({ slug: post.slug })}
						css={postLinkCss}
					>
						<p css={blogMetaCss}>
							{eyebrow
								? `${eyebrow(post, index)} · ${blogPostMetaText(post, { category: false })}`
								: blogPostMetaText(post, { category: showCategory })}
						</p>
						<h3 css={postTitleCss}>{post.title}</h3>
						<p css={postDescriptionCss}>{post.description}</p>
					</SiteLink>
				</li>
			))}
		</ul>
	)
}

export const blogMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
} satisfies CSSObject

export const blogSectionTitleCss = {
	margin: 'clamp(2.6rem, 6vw, 3.6rem) 0 0.9rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
} satisfies CSSObject

export const blogInlineLinkCss = {
	display: 'inline-flex',
	marginTop: '1.1rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': {
		color: colors.text,
	},
} satisfies CSSObject

/* One row that scrolls sideways on narrow screens instead of wrapping. */
const categoryNavCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '1.4rem',
	marginTop: 'clamp(1.8rem, 4vw, 2.4rem)',
	borderBottom: `1px solid ${colors.border}`,
	overflowX: 'auto' as const,
	scrollbarWidth: 'none' as const,
	whiteSpace: 'nowrap' as const,
	'&::-webkit-scrollbar': {
		display: 'none',
	},
} satisfies CSSObject

const categoryTabCss = {
	display: 'inline-flex',
	alignItems: 'baseline',
	gap: '0.4rem',
	flex: 'none',
	padding: '0.55rem 0.1rem',
	borderBottom: '2px solid transparent',
	color: colors.textMuted,
	fontSize: '0.95rem',
	fontWeight: 550,
	textDecoration: 'none',
	transition: `color ${transitions.fast}`,
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		color: colors.text,
		borderBottomColor: colors.primary,
	},
} satisfies CSSObject

const categoryCountCss = {
	color: colors.textMuted,
	fontSize: '0.8rem',
	fontWeight: 500,
	fontVariantNumeric: 'tabular-nums' as const,
} satisfies CSSObject

const postListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
} satisfies CSSObject

const postItemCss = {
	borderBottom: `1px solid ${colors.border}`,
	'&:first-of-type': {
		borderTop: `1px solid ${colors.border}`,
	},
} satisfies CSSObject

const postLinkCss = {
	display: 'block',
	padding: '1.4rem 0.2rem',
	textDecoration: 'none',
	color: 'inherit',
	'&:hover h3': {
		color: colors.primaryText,
	},
} satisfies CSSObject

export const postTitleCss = {
	margin: '0.35rem 0 0',
	fontSize: '1.3rem',
	fontWeight: 720,
	letterSpacing: '-0.016em',
	lineHeight: 1.2,
	textWrap: 'balance' as const,
	transition: `color ${transitions.fast}`,
} satisfies CSSObject

export const postDescriptionCss = {
	margin: '0.5rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '58ch',
	textWrap: 'pretty' as const,
} satisfies CSSObject

export const blogBackLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
} satisfies CSSObject

/* Category and series heads: the shared page-head scaffold, left-aligned. */
export const blogListingHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	marginTop: '1.6rem',
	'& h1': {
		...pageHeadCss['& h1'],
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
	},
	'& > p': {
		...pageHeadCss['& > p'],
		marginInline: 0,
	},
} satisfies CSSObject

/** @jsxImportSource @emotion/react */
import { landingArtAttrs, publicAsset } from '../public-assets.ts'
import type { CSSObject } from '@emotion/react'
import { type CSSProperties, useMemo } from 'react'
import {
	BLOG_AUTHOR_NAME,
	formatBlogPostDate,
} from '#universal/blog-display.ts'
import type { BlogPostLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { publicSignupPrimaryCta } from '#universal/public-signup-copy.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	getSurfaceCardCss,
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'
import { renderMarkdownNodes } from '../components/markdown-view.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { BlogPostList, blogCategoryLabel } from './blog-parts.tsx'
/** Blog posts are repo-authored, so they render with the first-party docs policy. */
export const blogPostMarkdownOptions = {
	headingOffset: 0,
	linkRel: 'noopener noreferrer',
	linkPolicy: 'first-party',
	headingIds: true,
	blogImages: true,
} as const

export function BlogPostRoute({ post }: { post: BlogPostLoaderData }) {
	const signedOutCta = publicSignupPrimaryCta()
	const renderedBody = useMemo(
		() =>
			renderMarkdownNodes(post.body, {
				...blogPostMarkdownOptions,
				fences: post.bodyFences,
			}),
		[post.body, post.bodyFences],
	)
	return (
		<article css={postCss}>
			<SiteLink
				data-rise
				style={{ '--rise': '0' } as CSSProperties}
				href={routes.blog.href()}
				css={postBackCss}
			>
				← Blog
			</SiteLink>

			{post !== null ? (
				<>
					<header css={postHeadCss}>
						<p
							data-rise
							style={{ '--rise': '1' } as CSSProperties}
							css={postEyebrowCss}
						>
							<SiteLink
								href={routes.blogCategory.href({ category: post.category })}
							>
								{blogCategoryLabel(post.category)}
							</SiteLink>
							{post.series ? (
								<>
									{' · '}
									<SiteLink
										href={routes.blogSeries.href({ series: post.series.slug })}
									>
										{post.series.title}, part {post.series.part} of{' '}
										{post.series.parts.length}
									</SiteLink>
								</>
							) : null}
						</p>
						<h1 data-rise style={{ '--rise': '1' } as CSSProperties}>
							{post.title}
						</h1>
						<p
							data-rise
							style={{ '--rise': '2' } as CSSProperties}
							css={postMetaCss}
						>
							{BLOG_AUTHOR_NAME} ·{' '}
							<time dateTime={post.date}>{formatBlogPostDate(post.date)}</time>
							{post.updated ? (
								<>
									{' · Updated '}
									<time dateTime={post.updated}>
										{formatBlogPostDate(post.updated)}
									</time>
								</>
							) : null}
							{` · ${post.readingMinutes} min read`}
						</p>
					</header>

					{post.image && post.imageAlt ? (
						<img
							src={publicAsset(post.image)}
							alt={post.imageAlt}
							width={1600}
							height={900}
							loading="eager"
							decoding="async"
							data-rise
							style={{ '--rise': '3' } as CSSProperties}
							css={postImageCss}
						/>
					) : null}

					<div css={proseCss}>{renderedBody}</div>

					<footer css={postFootCss}>
						{post.series ? <SeriesNav series={post.series} /> : null}
						{post.related.length > 0 ? (
							<section aria-labelledby="blog-related-heading">
								<h2 id="blog-related-heading" css={footHeadingCss}>
									Related
								</h2>
								<BlogPostList posts={post.related} />
							</section>
						) : null}
						<div css={postCtaCss}>
							<img
								{...landingArtAttrs('kody-greeting')}
								width={480}
								height={480}
								alt=""
							/>
							<p>
								Give your assistant a home of its own. Create a free account and
								start saving packages.
							</p>
							<SiteLink href={signedOutCta.href} css={postCtaButtonCss}>
								{signedOutCta.label}
							</SiteLink>
						</div>
					</footer>
				</>
			) : null}
		</article>
	)
}

function SeriesNav({
	series,
}: {
	series: NonNullable<BlogPostLoaderData['series']>
}) {
	const previous = series.parts[series.part - 2]
	const next = series.parts[series.part]
	return (
		<nav aria-labelledby="blog-series-nav-heading" css={seriesNavCss}>
			<h2 id="blog-series-nav-heading" css={footHeadingCss}>
				<SiteLink href={routes.blogSeries.href({ series: series.slug })}>
					{series.title}
				</SiteLink>
			</h2>
			<p css={postMetaCss}>
				Part {series.part} of {series.parts.length}
			</p>
			<div css={seriesStepsCss}>
				{previous ? (
					<SiteLink
						href={routes.blogPost.href({ slug: previous.slug })}
						css={seriesStepCss}
					>
						<span css={postMetaCss}>← Previous</span>
						<strong>{previous.title}</strong>
					</SiteLink>
				) : (
					<span />
				)}
				{next ? (
					<SiteLink
						href={routes.blogPost.href({ slug: next.slug })}
						css={[seriesStepCss, { textAlign: 'right' as const }]}
					>
						<span css={postMetaCss}>Next →</span>
						<strong>{next.title}</strong>
					</SiteLink>
				) : null}
			</div>
		</nav>
	)
}

const postCss = {
	maxWidth: '43rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

const postBackCss = {
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

/* The shared shirt-pattern whisper drifts behind the head, pulled toward the
   reading edge (the post head is left-aligned, unlike the centered page
   head). */
const postHeadCss = {
	position: 'relative' as const,
	// Borrows `pageHeadCss`'s `zIndex: -1` pseudo without the rest of it, so it
	// has to carry the `isolate` that scopes that negative z-index to this
	// element. `blogHeadCss` and timeline's `headCss` spread all of
	// `pageHeadCss` and inherit it for free.
	isolation: 'isolate' as const,
	marginTop: '1.8rem',
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-90% -30% -250%',
		background: `radial-gradient(ellipse 46% 55% at 70% 30%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.1rem, 5vw, 3rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& > p': {
		marginTop: '0.9rem',
	},
} satisfies CSSObject

const postMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
} satisfies CSSObject

const postImageCss = {
	display: 'block',
	width: '100%',
	height: 'auto',
	// HTML width/height stay a 16:9 reservation for older posts; let the
	// file's intrinsic ratio win so square art is not stretched.
	aspectRatio: 'auto',
	margin: 'clamp(1.5rem, 4vw, 2.2rem) 0 0',
	borderRadius: radius.card,
	border: `1px solid ${colors.border}`,
} satisfies CSSObject

const postFootCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
} satisfies CSSObject

const postEyebrowCss = {
	margin: '0 0 0.8rem',
	color: colors.textMuted,
	fontSize: '0.88rem',
	fontWeight: 550,
	'& a': {
		color: colors.primaryText,
		textDecoration: 'none',
	},
	'& a:hover': {
		color: colors.text,
		textDecoration: 'underline',
	},
} satisfies CSSObject

const footHeadingCss = {
	margin: '0 0 0.6rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	'& a': {
		color: 'inherit',
		textDecorationThickness: '1px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': {
		color: colors.text,
	},
} satisfies CSSObject

const seriesNavCss = {
	...getSurfaceCardCss(),
	padding: 'clamp(1.1rem, 3vw, 1.5rem)',
	marginBottom: 'clamp(2rem, 5vw, 2.8rem)',
	'& > h2': {
		marginBottom: '0.2rem',
	},
} satisfies CSSObject

const seriesStepsCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: '1.2rem',
	marginTop: '1rem',
	'@media (max-width: 560px)': {
		gridTemplateColumns: '1fr',
		'& a': {
			textAlign: 'left' as const,
		},
	},
} satisfies CSSObject

const seriesStepCss = {
	display: 'block',
	textDecoration: 'none',
	color: 'inherit',
	'& span': {
		display: 'block',
	},
	'& strong': {
		display: 'block',
		marginTop: '0.3rem',
		font: `700 1.05rem/1.3 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.01em',
		textWrap: 'balance' as const,
		transition: `color ${transitions.fast}`,
	},
	'&:hover strong': {
		color: colors.primaryText,
	},
} satisfies CSSObject

const postCtaCss = {
	marginTop: 'clamp(2rem, 5vw, 3rem)',
	display: 'flex',
	alignItems: 'center',
	gap: '1.2rem',
	flexWrap: 'wrap' as const,
	'& img': {
		width: '76px',
		height: '76px',
		flex: 'none',
	},
	'& p': {
		flex: 1,
		minWidth: 0,
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
	},
} satisfies CSSObject

const postCtaButtonCss = {
	...getPillButtonCss(),
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
} satisfies CSSObject

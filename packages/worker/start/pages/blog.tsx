/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import {
	BLOG_AUTHOR_NAME,
	formatBlogPostDate,
} from '#universal/blog-display.ts'
import {
	type BlogLoaderData,
	type BlogPostSummaryLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { hoverMq, pageHeadCss } from '#universal/styles/style-primitives.ts'
import { revealRef } from '../components/reveal.ts'
import { SiteLink } from '../components/site-link.tsx'
export function BlogRoute({ data }: { data: BlogLoaderData }) {
	const posts = data.posts
	const [featuredPost, ...listPosts] = posts
	return (
		<section css={blogPageCss}>
			<header css={blogHeadCss}>
				<h1 data-rise style={{ '--rise': '0' } as CSSProperties}>
					Notes from the <em>eucalyptus</em>
				</h1>
				<p data-rise style={{ '--rise': '1' } as CSSProperties}>
					Why your assistant deserves a home, written while building it. From{' '}
					{BLOG_AUTHOR_NAME}.
				</p>
				<SiteLink
					data-rise
					style={{ '--rise': '2' } as CSSProperties}
					href={routes.blogRss.href()}
					data-rmx-document
					css={rssLinkCss}
				>
					Subscribe via RSS
				</SiteLink>
			</header>

			{posts !== null && featuredPost ? (
				<ul css={postListCss}>
					{renderFeaturedPostItem(featuredPost)}
					{listPosts.map((post, index) => renderPostItem(post, index + 1))}
				</ul>
			) : null}
			{posts !== null && !featuredPost ? (
				<p css={listStatusCss}>No posts yet.</p>
			) : null}
		</section>
	)
}

/**
 * The newest post gets Kody at its side; everything below stays a list.
 * Reveal delays mirror the prototype's post-list stagger: 60ms steps,
 * capped at the fourth item.
 */
function renderFeaturedPostItem(post: BlogPostSummaryLoaderData) {
	return (
		<li key={post.slug} css={featuredItemCss} ref={revealRef(0, 'reveal-card')}>
			{/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- link name comes from the date, title, and description children */}
			<SiteLink
				href={routes.blogPost.href({ slug: post.slug })}
				css={featuredLinkCss}
			>
				<div>
					<p css={postMetaCss}>{formatBlogPostDate(post.date)}</p>
					<h2 css={featuredTitleCss}>{post.title}</h2>
					<p css={featuredDescriptionCss}>{post.description}</p>
				</div>
				<img
					src={publicAsset('/images/kody-agent-briefing.webp')}
					width={480}
					height={480}
					/*
					 * Decorative. The img sits inside the anchor, so alt text is
					 * appended to the link's accessible name — a screen reader
					 * would announce the date, title, description, and then a
					 * mascot description as one long link name. The art says
					 * nothing the copy does not already say.
					 */
					alt=""
					css={featuredArtCss}
				/>
			</SiteLink>
		</li>
	)
}

function renderPostItem(post: BlogPostSummaryLoaderData, index: number) {
	return (
		<li
			key={post.slug}
			css={postItemCss}
			ref={revealRef(Math.min(index, 3) * 60, 'reveal-card')}
		>
			<SiteLink
				href={routes.blogPost.href({ slug: post.slug })}
				css={postLinkCss}
			>
				<p css={postMetaCss}>{formatBlogPostDate(post.date)}</p>
				<h2 css={postTitleCss}>{post.title}</h2>
				<p css={postDescriptionCss}>{post.description}</p>
			</SiteLink>
		</li>
	)
}

const blogPageCss = {
	maxWidth: '46rem',
	marginInline: 'auto',
	padding:
		'clamp(3rem, 7vw, 5.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

/* The shared page-head scaffold, pulled left for the editorial column; the
   shirt-pattern whisper drifts off-center toward the reading edge. */
const blogHeadCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-70% -30% -200%',
		background: `radial-gradient(ellipse 48% 60% at 72% 36%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& > p': {
		...pageHeadCss['& > p'],
		marginInline: 0,
	},
} satisfies CSSObject

const rssLinkCss = {
	marginTop: '1.2rem',
	display: 'inline-flex',
	fontSize: '0.92rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': {
		color: colors.text,
	},
} satisfies CSSObject

const listStatusCss = {
	margin: 'clamp(2rem, 5vw, 3rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
} satisfies CSSObject

const postListCss = {
	listStyle: 'none',
	margin: 'clamp(2rem, 5vw, 3rem) 0 0',
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
	padding: '1.6rem 0.2rem',
	textDecoration: 'none',
	color: 'inherit',
	'&:hover h2': {
		color: colors.primaryText,
	},
} satisfies CSSObject

const postMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
} satisfies CSSObject

const postTitleCss = {
	margin: '0.35rem 0 0',
	fontSize: '1.4rem',
	fontWeight: 720,
	letterSpacing: '-0.016em',
	lineHeight: 1.2,
	textWrap: 'balance' as const,
	transition: `color ${transitions.fast}`,
} satisfies CSSObject

const postDescriptionCss = {
	margin: '0.5rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '58ch',
	textWrap: 'balance' as const,
} satisfies CSSObject

/* Featured description sits outside the prototype's balance list — it wraps
   long, where `pretty` reads better than strict balancing. */
const featuredDescriptionCss = {
	...postDescriptionCss,
	textWrap: 'pretty' as const,
} satisfies CSSObject

const featuredItemCss = {
	border: 'none',
} satisfies CSSObject

const featuredLinkCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(130px, 20vw, 190px)',
	gap: 'clamp(1.2rem, 3vw, 2.2rem)',
	alignItems: 'center',
	padding: '0 0.2rem clamp(1.8rem, 4vw, 2.5rem)',
	textDecoration: 'none',
	color: 'inherit',
	'&:hover h2': {
		color: colors.primaryText,
	},
	// Gated: touch taps would otherwise leave the mascot stuck mid-lift.
	[hoverMq]: {
		'&:hover img': {
			transform: 'translateY(-6px) rotate(-0.5deg)',
		},
	},
	'@media (max-width: 560px)': {
		gridTemplateColumns: '1fr',
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:hover img': {
			transform: 'none',
		},
	},
} satisfies CSSObject

const featuredTitleCss = {
	...postTitleCss,
	fontSize: 'clamp(1.6rem, 3.2vw, 2rem)',
} satisfies CSSObject

const featuredArtCss = {
	width: '100%',
	height: 'auto',
	transition: `transform 200ms ${transitions.easeOut}`,
	'@media (max-width: 560px)': {
		width: 'min(52%, 200px)',
		marginInline: 'auto',
		order: -1,
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
	},
} satisfies CSSObject

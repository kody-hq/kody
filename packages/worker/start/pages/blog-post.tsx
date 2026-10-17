/** @jsxImportSource @emotion/react */
import { landingArtAttrs, publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties, useMemo } from 'react'
import {
	BLOG_AUTHOR_NAME,
	BLOG_PLACEHOLDER_CALLOUT,
	formatBlogPostDate,
} from '#universal/blog-display.ts'
import { type BlogPostLoaderData } from '#universal/loader-data.ts'
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
	pageHeadCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'
import { renderMarkdownNodes } from '../components/markdown-view.tsx'
import { SiteLink } from '../components/site-link.tsx'
export function BlogPostRoute({ post }: { post: BlogPostLoaderData }) {
	const signedOutCta = publicSignupPrimaryCta()
	const renderedBody = useMemo(
		() =>
			renderMarkdownNodes(post.body, {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
				headingIds: true,
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
				← All posts
			</SiteLink>

			{post !== null ? (
				<>
					<header css={postHeadCss}>
						<h1 data-rise style={{ '--rise': '1' } as CSSProperties}>
							{post.title}
						</h1>
						<p
							data-rise
							style={{ '--rise': '2' } as CSSProperties}
							css={postMetaCss}
						>
							{BLOG_AUTHOR_NAME} · {formatBlogPostDate(post.date)}
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

					{post.placeholder ? (
						<aside
							data-rise
							style={{ '--rise': '4' } as CSSProperties}
							css={placeholderCalloutCss}
							role="note"
						>
							<p>{BLOG_PLACEHOLDER_CALLOUT}</p>
						</aside>
					) : null}

					<div css={proseCss}>{renderedBody}</div>

					<footer css={postFootCss}>
						{post.readNext ? (
							<SiteLink
								href={routes.blogPost.href({ slug: post.readNext.slug })}
								css={readNextCss}
							>
								<span css={postMetaCss}>Read next</span>
								<strong>{post.readNext.title}</strong>
							</SiteLink>
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

const placeholderCalloutCss = {
	marginTop: 'clamp(1.4rem, 3vw, 2rem)',
	padding: '1rem 1.15rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	backgroundColor: colors.surface,
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.95rem',
		lineHeight: 1.5,
		maxWidth: '62ch',
		textWrap: 'pretty' as const,
	},
} satisfies CSSObject

const postFootCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
} satisfies CSSObject

const readNextCss = {
	display: 'block',
	textDecoration: 'none',
	color: 'inherit',
	'& span': {
		display: 'block',
	},
	'& strong': {
		display: 'block',
		marginTop: '0.3rem',
		font: `720 1.25rem/1.25 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.014em',
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

/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { CSSProperties } from 'react'
import type { BlogSeriesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	BlogPostList,
	blogBackLinkCss,
	blogInlineLinkCss,
	blogListingHeadCss,
} from './blog-parts.tsx'

/** Every part of a series in reading order (oldest first). */
export function BlogSeriesRoute({ data }: { data: BlogSeriesLoaderData }) {
	const first = data.posts[0]
	return (
		<section css={pageCss}>
			<SiteLink href={routes.blog.href()} css={blogBackLinkCss}>
				← Blog
			</SiteLink>
			<header css={blogListingHeadCss}>
				<div css={eyebrowCss}>Series · {data.posts.length} parts</div>
				<h1 data-rise style={{ '--rise': '0' } as CSSProperties}>
					{data.title}
				</h1>
				<p data-rise style={{ '--rise': '1' } as CSSProperties}>
					{data.description}
				</p>
				{first ? (
					<SiteLink
						href={routes.blogPost.href({ slug: first.slug })}
						css={blogInlineLinkCss}
					>
						Start with part 1 →
					</SiteLink>
				) : null}
			</header>
			<div css={listCss}>
				<BlogPostList
					posts={data.posts}
					eyebrow={(_post, index) => `Part ${index + 1}`}
				/>
			</div>
		</section>
	)
}

const pageCss = {
	maxWidth: '46rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

const eyebrowCss = {
	margin: '0 0 0.6rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
} satisfies CSSObject

const listCss = {
	marginTop: 'clamp(2rem, 5vw, 2.8rem)',
} satisfies CSSObject

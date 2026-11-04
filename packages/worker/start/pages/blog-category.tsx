/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { CSSProperties } from 'react'
import type {
	BlogCategoryLoaderData,
	BlogPostSummaryLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	BlogCategoryNav,
	BlogPostList,
	blogBackLinkCss,
	blogInlineLinkCss,
	blogListingHeadCss,
	blogSectionTitleCss,
} from './blog-parts.tsx'

/** A category's full archive, newest first, grouped by year. */
export function BlogCategoryRoute({ data }: { data: BlogCategoryLoaderData }) {
	return (
		<section css={pageCss}>
			<SiteLink href={routes.blog.href()} css={blogBackLinkCss}>
				← Blog
			</SiteLink>
			<header css={blogListingHeadCss}>
				<h1 data-rise style={{ '--rise': '0' } as CSSProperties}>
					{data.label}
				</h1>
				<p data-rise style={{ '--rise': '1' } as CSSProperties}>
					{data.description}
				</p>
				<SiteLink
					href={routes.blogCategoryRss.href({ category: data.slug })}
					reloadDocument
					css={blogInlineLinkCss}
				>
					Subscribe to {data.label.toLowerCase()} via RSS
				</SiteLink>
			</header>

			<BlogCategoryNav categories={data.categories} active={data.slug} />

			{groupByYear(data.posts).map(([year, posts]) => (
				<section key={year} aria-labelledby={`blog-year-${year}`}>
					<h2 id={`blog-year-${year}`} css={blogSectionTitleCss}>
						{year}
					</h2>
					<BlogPostList posts={posts} showCategory={false} />
				</section>
			))}
		</section>
	)
}

function groupByYear(posts: ReadonlyArray<BlogPostSummaryLoaderData>) {
	const groups = new Map<string, Array<BlogPostSummaryLoaderData>>()
	for (const post of posts) {
		const year = post.date.slice(0, 4)
		groups.set(year, [...(groups.get(year) ?? []), post])
	}
	return [...groups]
}

const pageCss = {
	maxWidth: '46rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
} satisfies CSSObject

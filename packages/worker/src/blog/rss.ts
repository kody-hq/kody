import { blogCategories, type BlogCategory } from '#universal/blog-taxonomy.ts'
import type { BlogPost } from './parse-frontmatter.ts'

const BLOG_FEED_TITLE = 'Kody Blog'
const BLOG_FEED_DESCRIPTION =
	'Essays, how-to guides, release notes, and customer stories about Kody, from Kent C. Dodds.'

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

function toRfc822Date(date: string): string {
	return new Date(`${date}T12:00:00.000Z`).toUTCString()
}

function categoryLabel(slug: string) {
	return (
		blogCategories.find((category) => category.slug === slug)?.label ?? slug
	)
}

/**
 * Build a minimal RSS 2.0 feed for the public blog, or for one category when
 * `category` is set. Item descriptions use the frontmatter summary (not the
 * full markdown body) to keep the feed small.
 */
export function buildBlogRssXml(input: {
	origin: string
	posts: ReadonlyArray<BlogPost>
	category?: BlogCategory
}): string {
	const channelPath = input.category
		? `/blog/category/${input.category.slug}`
		: '/blog'
	const channelLink = `${input.origin}${channelPath}`
	const title = input.category
		? `${BLOG_FEED_TITLE}: ${input.category.label}`
		: BLOG_FEED_TITLE
	const description = input.category?.description ?? BLOG_FEED_DESCRIPTION
	const items = input.posts
		.map((post) => {
			const link = `${input.origin}/blog/${post.slug}`
			return [
				'    <item>',
				`      <title>${escapeXml(post.title)}</title>`,
				`      <link>${escapeXml(link)}</link>`,
				`      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
				`      <pubDate>${escapeXml(toRfc822Date(post.date))}</pubDate>`,
				`      <category>${escapeXml(categoryLabel(post.category))}</category>`,
				`      <description>${escapeXml(post.description)}</description>`,
				'    </item>',
			].join('\n')
		})
		.join('\n')

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0">',
		'  <channel>',
		`    <title>${escapeXml(title)}</title>`,
		`    <link>${escapeXml(channelLink)}</link>`,
		`    <description>${escapeXml(description)}</description>`,
		items,
		'  </channel>',
		'</rss>',
		'',
	].join('\n')
}

import type { BlogPost } from './parse-frontmatter.ts'

const BLOG_FEED_TITLE = 'Kody Blog'
const BLOG_FEED_DESCRIPTION =
	'Updates and positioning posts from Kent C. Dodds about Kody.'

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

/**
 * Build a minimal RSS 2.0 feed for the public blog. Item descriptions use the
 * frontmatter summary (not the full markdown body) to keep the feed small.
 */
export function buildBlogRssXml(input: {
	origin: string
	posts: ReadonlyArray<BlogPost>
}): string {
	const channelLink = `${input.origin}/blog`
	const items = input.posts
		.map((post) => {
			const link = `${input.origin}/blog/${post.slug}`
			return [
				'    <item>',
				`      <title>${escapeXml(post.title)}</title>`,
				`      <link>${escapeXml(link)}</link>`,
				`      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
				`      <pubDate>${escapeXml(toRfc822Date(post.date))}</pubDate>`,
				`      <description>${escapeXml(post.description)}</description>`,
				'    </item>',
			].join('\n')
		})
		.join('\n')

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0">',
		'  <channel>',
		`    <title>${escapeXml(BLOG_FEED_TITLE)}</title>`,
		`    <link>${escapeXml(channelLink)}</link>`,
		`    <description>${escapeXml(BLOG_FEED_DESCRIPTION)}</description>`,
		items,
		'  </channel>',
		'</rss>',
		'',
	].join('\n')
}

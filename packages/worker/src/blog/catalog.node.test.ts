import { expect, test } from 'vitest'
import { blogPostSlugs } from '#universal/blog-post-slugs.ts'
import {
	blogCategories,
	blogSeries,
	estimateReadingMinutes,
} from '#universal/blog-taxonomy.ts'
import {
	getBlogSeriesNav,
	getFeaturedBlogPost,
	getRelatedBlogPosts,
	listBlogCategoriesWithPosts,
	listBlogPosts,
	listBlogSeriesPosts,
	normalizeMarkdownPhraseSource,
} from './catalog.ts'
import { parseBlogPostMarkdown } from './parse-frontmatter.ts'
import { buildBlogRssXml } from './rss.ts'

const markdown = (frontmatter: string, body = 'Body\n') =>
	`---\n${frontmatter}\n---\n\n${body}`
const baseFrontmatter =
	'date: 2026-08-20\ndescription: Nope\norder: 1\ncategory: essays'

test('normalizeMarkdownPhraseSource strips blockquote markers and wrapping', () => {
	expect(
		normalizeMarkdownPhraseSource(
			'> funnels all my tools into one secure MCP\n> I can manage myself\n',
		),
	).toBe('funnels all my tools into one secure MCP I can manage myself ')
})

test('parseBlogPostMarkdown reads frontmatter and rejects invalid input', () => {
	expect(
		parseBlogPostMarkdown(
			'sample',
			markdown(
				'title: Sample title\ndate: 2026-07-18\ndescription: A short description for meta tags.\norder: 3\ncategory: how-to',
				'# Hello\n\nBody paragraph.\n',
			),
		),
	).toEqual({
		slug: 'sample',
		title: 'Sample title',
		date: '2026-07-18',
		updated: null,
		description: 'A short description for meta tags.',
		order: 3,
		category: 'how-to',
		series: null,
		featured: false,
		placeholder: true,
		image: null,
		imageAlt: null,
		ogImage: null,
		body: '# Hello\n\nBody paragraph.\n',
		readingMinutes: 1,
	})

	expect(
		parseBlogPostMarkdown(
			'multiline',
			markdown(
				'title: Multiline\ndate: 2026-07-19\ndescription:\n  First sentence about the post.\n  Second sentence for meta tags.\norder: 2\ncategory: essays',
			),
		).description,
	).toBe('First sentence about the post. Second sentence for meta tags.')

	expect(
		parseBlogPostMarkdown(
			'reviewed',
			markdown(
				`title: Reviewed\n${baseFrontmatter}\nplaceholder: false\nimage: /images/openclaw-2-needs-a-home.webp\nimageAlt: Kody stands with his arm around OpenClaw.`,
			),
		),
	).toMatchObject({
		placeholder: false,
		image: '/images/openclaw-2-needs-a-home.webp',
		imageAlt: 'Kody stands with his arm around OpenClaw.',
		ogImage: null,
	})

	expect(
		parseBlogPostMarkdown(
			'custom-og',
			markdown(
				`title: Custom OG\n${baseFrontmatter}\nimage: /images/openclaw-2-needs-a-home.webp\nimageAlt: Headline art.\nogImage: /images/openclaw-2-needs-a-home.webp`,
			),
		).ogImage,
	).toBe('/images/openclaw-2-needs-a-home.webp')

	for (const [frontmatter, error] of [
		[
			'title: Bad date\ndate: 07/20/2026\ndescription: Nope\norder: 1\ncategory: essays',
			/invalid frontmatter "date"/,
		],
		[
			'title: No category\ndate: 2026-08-20\ndescription: Nope\norder: 1',
			/missing frontmatter "category"/,
		],
		[
			`title: Unknown category\ndate: 2026-08-20\ndescription: Nope\norder: 1\ncategory: news`,
			/unknown frontmatter "category" "news"/,
		],
		[
			`title: Unknown series\n${baseFrontmatter}\nseries: nope`,
			/unknown frontmatter "series" "nope"/,
		],
		[
			`title: Unknown key\n${baseFrontmatter}\ntags: agents`,
			/unknown frontmatter "tags"/,
		],
		[
			`title: Early update\n${baseFrontmatter}\nupdated: 2026-08-19`,
			/invalid frontmatter "updated"/,
		],
		[
			`title: Bad featured\n${baseFrontmatter}\nfeatured: yes`,
			/invalid frontmatter "featured"/,
		],
		[baseFrontmatter, /missing frontmatter "title"/],
		[
			`title: Bad placeholder\n${baseFrontmatter}\nplaceholder: maybe`,
			/invalid frontmatter "placeholder"/,
		],
		[
			`title: Bad image\n${baseFrontmatter}\nimage: https://example.com/image.webp\nimageAlt: Nope`,
			/invalid frontmatter "image"/,
		],
	] as const) {
		expect(() => parseBlogPostMarkdown('bad', markdown(frontmatter))).toThrow(
			error,
		)
	}
})

test('parseBlogPostMarkdown rejects reserved and non-kebab slugs', () => {
	for (const slug of ['category', 'series', 'rss', 'Bad_Slug']) {
		expect(() =>
			parseBlogPostMarkdown(slug, markdown(`title: Slug\n${baseFrontmatter}`)),
		).toThrow(/slug/)
	}
})

test('every catalog post uses the fixed taxonomy and the client slug list', () => {
	const posts = listBlogPosts()
	const categorySlugs: ReadonlyArray<string> = blogCategories.map(
		(category) => category.slug,
	)
	for (const post of posts) {
		expect(categorySlugs).toContain(post.category)
		expect(post.readingMinutes).toBeGreaterThan(0)
	}
	expect([...blogPostSlugs].sort()).toEqual(
		posts.map((post) => post.slug).sort(),
	)
	expect(posts.filter((post) => post.featured).length).toBeLessThanOrEqual(1)
	expect(
		listBlogCategoriesWithPosts().reduce((sum, c) => sum + c.count, 0),
	).toBe(posts.length)
	expect(getFeaturedBlogPost()?.category).not.toBe('updates')
})

test('series nav lists every part oldest first with prev/next positions', () => {
	for (const series of blogSeries) {
		const parts = listBlogSeriesPosts(series.slug)
		expect(parts.length).toBeGreaterThanOrEqual(2)
		const dates = parts.map((post) => post.date)
		expect(dates).toEqual([...dates].sort())
		parts.forEach((post, index) => {
			const nav = getBlogSeriesNav(post.slug)
			expect(nav?.part).toBe(index + 1)
			expect(nav?.parts.map((part) => part.slug)).toEqual(
				parts.map((part) => part.slug),
			)
		})
	}
	const standalone = listBlogPosts().find((post) => post.series === null)!
	expect(getBlogSeriesNav(standalone.slug)).toBeNull()
})

test('related posts skip the post itself, its series, and stay at three', () => {
	for (const post of listBlogPosts()) {
		const related = getRelatedBlogPosts(post.slug)
		expect(related.length).toBeLessThanOrEqual(3)
		for (const other of related) {
			expect(other.slug).not.toBe(post.slug)
			if (post.series) expect(other.series).not.toBe(post.series)
		}
	}
	expect(getRelatedBlogPosts('does-not-exist')).toEqual([])
})

test('estimateReadingMinutes ignores code fences and floors at one', () => {
	expect(estimateReadingMinutes('')).toBe(1)
	expect(estimateReadingMinutes('word '.repeat(460))).toBe(2)
	expect(
		estimateReadingMinutes(
			`intro\n\n\`\`\`\n${'code '.repeat(1000)}\n\`\`\`\n`,
		),
	).toBe(1)
})

test('buildBlogRssXml escapes markup and includes every catalog post', () => {
	const posts = listBlogPosts()
	const xml = buildBlogRssXml({ origin: 'https://heykody.dev', posts })

	expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
	expect(xml).toContain('<rss version="2.0">')
	expect(xml).toContain('<link>https://heykody.dev/blog</link>')

	for (const post of posts) {
		expect(xml).toContain(`<link>https://heykody.dev/blog/${post.slug}</link>`)
		const escapedTitle = post.title
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&apos;')
		expect(xml).toContain(`<title>${escapedTitle}</title>`)
	}

	const escaped = buildBlogRssXml({
		origin: 'https://example.com',
		posts: [
			{
				slug: 'amp',
				title: 'A & B <C>',
				date: '2026-07-20',
				updated: null,
				description: `Say "hi" & 'bye'`,
				order: 1,
				category: 'essays',
				series: null,
				featured: false,
				placeholder: true,
				image: null,
				imageAlt: null,
				ogImage: null,
				body: 'unused',
				readingMinutes: 1,
			},
		],
	})
	expect(escaped).toContain('A &amp; B &lt;C&gt;')
	expect(escaped).toContain('Say &quot;hi&quot; &amp; &apos;bye&apos;')
})

test('buildBlogRssXml scopes a category feed', () => {
	const category = blogCategories.find((entry) => entry.slug === 'how-to')!
	const posts = listBlogPosts().filter((post) => post.category === 'how-to')
	const xml = buildBlogRssXml({ origin: 'https://kody.codes', posts, category })
	expect(xml).toContain('<title>Kody Blog: How-to</title>')
	expect(xml).toContain('<link>https://kody.codes/blog/category/how-to</link>')
	expect(xml.match(/<item>/g)?.length).toBe(posts.length)
	expect(xml).not.toContain('<category>Essays</category>')
})

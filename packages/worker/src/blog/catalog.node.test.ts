import { expect, test } from 'vitest'
import {
	getReadNextBlogPost,
	listBlogPosts,
	normalizeMarkdownPhraseSource,
} from './catalog.ts'
import { parseBlogPostMarkdown } from './parse-frontmatter.ts'
import { buildBlogRssXml } from './rss.ts'

const markdown = (frontmatter: string, body = 'Body\n') =>
	`---\n${frontmatter}\n---\n\n${body}`
const baseFrontmatter = 'date: 2026-08-20\ndescription: Nope\norder: 1'

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
				'title: Sample title\ndate: 2026-07-18\ndescription: A short description for meta tags.\norder: 3',
				'# Hello\n\nBody paragraph.\n',
			),
		),
	).toEqual({
		slug: 'sample',
		title: 'Sample title',
		date: '2026-07-18',
		description: 'A short description for meta tags.',
		order: 3,
		placeholder: true,
		image: null,
		imageAlt: null,
		ogImage: null,
		body: '# Hello\n\nBody paragraph.\n',
	})

	expect(
		parseBlogPostMarkdown(
			'multiline',
			markdown(
				'title: Multiline\ndate: 2026-07-19\ndescription:\n  First sentence about the post.\n  Second sentence for meta tags.\norder: 2',
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
			'title: Bad date\ndate: 07/20/2026\ndescription: Nope\norder: 1',
			/invalid frontmatter "date"/,
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

test('getReadNextBlogPost follows catalog order and wraps to the first post', () => {
	const posts = listBlogPosts()
	expect(posts.length).toBeGreaterThan(1)
	expect(posts.map((post) => getReadNextBlogPost(post.slug))).toEqual(
		posts.map((_, index) => {
			const next = posts[(index + 1) % posts.length]!
			return { slug: next.slug, title: next.title }
		}),
	)
	expect(getReadNextBlogPost('does-not-exist')).toBeNull()
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
				description: `Say "hi" & 'bye'`,
				order: 1,
				placeholder: true,
				image: null,
				imageAlt: null,
				ogImage: null,
				body: 'unused',
			},
		],
	})
	expect(escaped).toContain('A &amp; B &lt;C&gt;')
	expect(escaped).toContain('Say &quot;hi&quot; &amp; &apos;bye&apos;')
})

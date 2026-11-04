import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { renderMarkdownNodes } from '../components/markdown-view.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { blogPostMarkdownOptions } from './blog-post.tsx'

async function renderBlogBody(body: string) {
	return renderStartPage(
		jsx('div', {
			children: renderMarkdownNodes(body, blogPostMarkdownOptions),
		}),
		'/blog',
	)
}

test('blog posts render root-relative markdown links as same-site links', async () => {
	for (const post of listBlogPosts()) {
		const html = await renderBlogBody(post.body)
		for (const [, href] of post.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
			expect(html, `${post.slug} links ${href}`).toContain(`href="${href}"`)
		}
	}
})

test('blog posts render first-party watch blocks as youtube embeds', async () => {
	const post = listBlogPosts().find(
		(entry) => entry.slug === 'engineers-are-handing-private-keys-to-ai-agents',
	)
	expect(post).toBeDefined()
	const html = await renderBlogBody(post!.body)
	expect(html).toContain('data-doc-youtube')
	expect(html).toContain('/youtube-thumb/m8I2p3nQtR4')
	expect(html).not.toContain('[!WATCH]')
	expect(html).toContain('href="/blog/where-to-store-api-keys-for-ai-agents"')
})

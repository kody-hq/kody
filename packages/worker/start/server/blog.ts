import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
export const loadBlog = createServerFn({ method: 'GET' }).handler(async () => {
	const { listBlogPosts, toBlogPostSummary } =
		await import('../../src/blog/catalog.ts')
	const blog = {
		ok: true as const,
		posts: listBlogPosts().map(toBlogPostSummary),
	}
	const { loadDocumentHead } = await import('./document-head.ts')
	return { ...blog, head: loadDocumentHead('blog', '/blog', { blog }) }
})

export const loadBlogPost = createServerFn({ method: 'GET' })
	.validator((data: { slug: string }) => {
		if (typeof data.slug !== 'string' || !data.slug || data.slug.includes('/'))
			throw new Error('Invalid blog slug')
		return data
	})
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getBlogPost, getReadNextBlogPost },
			{ highlightMarkdownFences },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('../../src/blog/catalog.ts'),
			import('../../src/app/highlight-code.ts'),
		])
		const post = getBlogPost(data.slug)
		if (!post) throw notFound()
		const blogPost = {
			ok: true as const,
			slug: post.slug,
			title: post.title,
			date: post.date,
			description: post.description,
			placeholder: post.placeholder,
			image: post.image,
			imageAlt: post.imageAlt,
			ogImage: post.ogImage,
			body: post.body,
			bodyFences: await highlightMarkdownFences(getEnv(env), post.body),
			readNext: getReadNextBlogPost(post.slug),
		}
		const { loadDocumentHead } = await import('./document-head.ts')
		return {
			...blogPost,
			head: loadDocumentHead(
				'blogPost',
				`/blog/${encodeURIComponent(post.slug)}`,
				{
					blogPost,
				},
			),
		}
	})

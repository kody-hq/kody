import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'

/** Latest non-update posts on the index; categories hold the full archive. */
const INDEX_LATEST_LIMIT = 10
const INDEX_UPDATES_LIMIT = 3

export const loadBlog = createServerFn({ method: 'GET' }).handler(async () => {
	const [
		{
			getFeaturedBlogPost,
			listBlogCategoriesWithPosts,
			listBlogCategoryPosts,
			listBlogPosts,
			listBlogSeriesPosts,
			toBlogPostSummary,
		},
		{ blogSeries },
	] = await Promise.all([
		import('../../src/blog/catalog.ts'),
		import('#universal/blog-taxonomy.ts'),
	])
	const featured = getFeaturedBlogPost()
	const blog = {
		ok: true as const,
		categories: listBlogCategoriesWithPosts(),
		featured: featured ? toBlogPostSummary(featured) : null,
		series: blogSeries.map((series) => {
			const parts = listBlogSeriesPosts(series.slug)
			return {
				slug: series.slug,
				title: series.title,
				description: series.description,
				count: parts.length,
				firstSlug: parts[0]?.slug ?? null,
			}
		}),
		latest: listBlogPosts()
			.filter(
				(post) => post.category !== 'updates' && post.slug !== featured?.slug,
			)
			.slice(0, INDEX_LATEST_LIMIT)
			.map(toBlogPostSummary),
		updates: listBlogCategoryPosts('updates')
			.slice(0, INDEX_UPDATES_LIMIT)
			.map(toBlogPostSummary),
	}
	const { loadDocumentHead } = await import('./document-head.ts')
	return { ...blog, head: loadDocumentHead('blog', '/blog', { blog }) }
})

export const loadBlogCategory = createServerFn({ method: 'GET' })
	.validator((data: { category: string }) => {
		if (typeof data.category !== 'string' || !data.category)
			throw new Error('Invalid blog category')
		return data
	})
	.handler(async ({ data }) => {
		const [
			{ listBlogCategoriesWithPosts, listBlogCategoryPosts, toBlogPostSummary },
			{ getBlogCategory },
		] = await Promise.all([
			import('../../src/blog/catalog.ts'),
			import('#universal/blog-taxonomy.ts'),
		])
		const category = getBlogCategory(data.category)
		if (!category) throw notFound()
		const blogCategory = {
			ok: true as const,
			slug: category.slug,
			label: category.label,
			description: category.description,
			categories: listBlogCategoriesWithPosts(),
			posts: listBlogCategoryPosts(category.slug).map(toBlogPostSummary),
		}
		const { loadDocumentHead } = await import('./document-head.ts')
		return {
			...blogCategory,
			head: loadDocumentHead(
				'blogCategory',
				`/blog/category/${category.slug}`,
				{ blogCategory },
			),
		}
	})

export const loadBlogSeries = createServerFn({ method: 'GET' })
	.validator((data: { series: string }) => {
		if (typeof data.series !== 'string' || !data.series)
			throw new Error('Invalid blog series')
		return data
	})
	.handler(async ({ data }) => {
		const [{ listBlogSeriesPosts, toBlogPostSummary }, { getBlogSeries }] =
			await Promise.all([
				import('../../src/blog/catalog.ts'),
				import('#universal/blog-taxonomy.ts'),
			])
		const series = getBlogSeries(data.series)
		if (!series) throw notFound()
		const blogSeries = {
			ok: true as const,
			slug: series.slug,
			title: series.title,
			description: series.description,
			posts: listBlogSeriesPosts(series.slug).map(toBlogPostSummary),
		}
		const { loadDocumentHead } = await import('./document-head.ts')
		return {
			...blogSeries,
			head: loadDocumentHead('blogSeries', `/blog/series/${series.slug}`, {
				blogSeries,
			}),
		}
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
			{ getBlogPost, getBlogSeriesNav, getRelatedBlogPosts },
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
			updated: post.updated,
			description: post.description,
			category: post.category,
			readingMinutes: post.readingMinutes,
			placeholder: post.placeholder,
			image: post.image,
			imageAlt: post.imageAlt,
			ogImage: post.ogImage,
			body: post.body,
			bodyFences: await highlightMarkdownFences(getEnv(env), post.body, {
				firstParty: true,
			}),
			series: getBlogSeriesNav(post.slug),
			related: getRelatedBlogPosts(post.slug),
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

import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { publicOgPages } from '#universal/og-pages.ts'
import { withAgentHref, withAgents } from '#universal/with-agents.ts'
import {
	listBlogCategoriesWithPosts,
	listBlogCategoryPosts,
	listBlogPosts,
	listBlogSeriesPosts,
} from '#worker/blog/catalog.ts'
import { blogSeries, getBlogCategory } from '#universal/blog-taxonomy.ts'

/** Public discovery excludes account access and recovery screens. */
const accountPaths = new Set(['/login', '/signup', '/reset-password'])

/**
 * Catalog of signed-out website pages for public discovery (llms.txt, sitemap,
 * docs index). Excludes account access/recovery paths.
 */
export function listPublicWebsitePages() {
	return [
		...acquisitionPageSummaries,
		...Object.values(publicOgPages)
			.filter((page) => !accountPaths.has(page.path))
			.map((page) => ({
				path: page.path,
				title: page.ogTitle,
				description: page.ogDescription,
			})),
		...withAgents.map((agent) => ({
			path: withAgentHref(agent.slug),
			title: `Kody for ${agent.name}`,
			description: agent.pitch,
		})),
		{
			path: '/docs',
			title: 'Kody Docs',
			description: 'Learn how to use Kody.',
		},
		{
			path: '/docs/connect',
			title: 'Connect a provider',
			description: 'Set up connections to your accounts.',
		},
		{
			path: '/auth.md',
			title: 'Connect your agent',
			description: 'OAuth and MCP endpoint details.',
		},
	]
}

/**
 * Catalog of public blog post URLs for discovery feeds (llms.txt, sitemap).
 */
export function listPublicBlogPages() {
	const posts = listBlogPosts().map((post) => ({
		path: `/blog/${post.slug}`,
		title: post.title,
		description: post.description,
		lastmod: post.updated ?? post.date,
	}))
	const categories = listBlogCategoriesWithPosts().map((summary) => {
		const category = getBlogCategory(summary.slug)!
		return {
			path: `/blog/category/${category.slug}`,
			title: `Kody blog: ${category.label}`,
			description: category.description,
			lastmod: listBlogCategoryPosts(category.slug)[0]!.date,
		}
	})
	const series = blogSeries.map((entry) => {
		const parts = listBlogSeriesPosts(entry.slug)
		return {
			path: `/blog/series/${entry.slug}`,
			title: `Kody blog series: ${entry.title}`,
			description: entry.description,
			lastmod: parts.at(-1)!.date,
		}
	})
	return [...posts, ...categories, ...series]
}

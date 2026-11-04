/**
 * The blog's fixed taxonomy. Every post names exactly one category; a post may
 * also belong to one series. Frontmatter that names anything not listed here
 * fails the catalog parse (and CI). Client-safe: no markdown imports.
 *
 * Authoring rules: docs/contributing/blog.md
 */
export const blogCategories = [
	{
		slug: 'essays',
		label: 'Essays',
		description:
			'Why Kody works the way it does, and opinions on agents, ownership, security, and cost.',
	},
	{
		slug: 'how-to',
		label: 'How-to',
		description:
			'Step-by-step setups, checklists, and playbooks for running AI agents with real access.',
	},
	{
		slug: 'updates',
		label: 'Updates',
		description: 'Weekly release notes and product announcements.',
	},
	{
		slug: 'stories',
		label: 'Customer stories',
		description: 'People using Kody, in their own words.',
	},
] as const

export type BlogCategory = (typeof blogCategories)[number]
export type BlogCategorySlug = BlogCategory['slug']

export const blogSeries = [
	{
		slug: 'agent-credentials-for-team-leads',
		title: 'Agent credentials for team leads',
		description:
			'Giving a team’s AI agents real access without handing them the keys: storage, scopes, revocation, audit, sharing, and rollout.',
	},
] as const

export type BlogSeries = (typeof blogSeries)[number]
export type BlogSeriesSlug = BlogSeries['slug']

export function getBlogCategory(slug: string): BlogCategory | null {
	return blogCategories.find((category) => category.slug === slug) ?? null
}

export function getBlogSeries(slug: string): BlogSeries | null {
	return blogSeries.find((series) => series.slug === slug) ?? null
}

/**
 * First path segments under `/blog/` that belong to listing pages and feeds,
 * so no post slug may use them.
 */
export const reservedBlogSlugs = ['category', 'series', 'rss'] as const

/** About 230 words a minute, rounded up, never below one minute. */
export function estimateReadingMinutes(markdown: string) {
	const words = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.split(/\s+/)
		.filter(Boolean).length
	return Math.max(1, Math.ceil(words / 230))
}

import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { blogPostSlugs } from '#universal/blog-post-slugs.ts'
import { blogCategories, blogSeries } from '#universal/blog-taxonomy.ts'
import { listDocsNavSlugs } from '#universal/docs-nav.ts'
import { withAgentHref, withAgents } from '#universal/with-agents.ts'

// Public pixel owned by the Kody organization. Never load on preview hosts.
const pixelId = '45bb291d-1173-47ce-a996-7214c1787914'
const publicPaths = new Set([
	...acquisitionPageSummaries.map((page) => page.path),
	'/',
	'/pricing',
	'/faq',
	'/case-studies',
	'/believe',
	...withAgents.map((agent) => withAgentHref(agent.slug)),
	'/community',
	'/blog',
	'/docs',
	// Provider index is public docs chrome, not a catalog slug.
	'/docs/connect',
	...listDocsNavSlugs({ includeAdmin: false }).map((slug) => `/docs/${slug}`),
	// Catalog slugs only — unknown /blog/:slug shapes (including 404s) stay out.
	...blogPostSlugs.map((slug) => `/blog/${slug}`),
	...blogCategories.map((category) => `/blog/category/${category.slug}`),
	...blogSeries.map((series) => `/blog/series/${series.slug}`),
])

export function scarfPageUrl(href: string): string | null {
	const url = new URL(href)
	if (url.origin !== 'https://kody.codes') return null
	if (!publicPaths.has(url.pathname)) return null
	// Never send query strings, fragments, referrers, account IDs, or content.
	return `${url.origin}${url.pathname}`
}

export function createScarfPageTracker() {
	let previousPage: string | null = null
	return function trackScarfPage() {
		try {
			const page = scarfPageUrl(window.location.href)
			if (page === previousPage) return
			previousPage = page
			if (
				!page ||
				navigator.doNotTrack === '1' ||
				(navigator as Navigator & { globalPrivacyControl?: boolean })
					.globalPrivacyControl
			)
				return
			const pixel = new Image()
			pixel.referrerPolicy = 'no-referrer'
			const url = new URL('https://static.scarf.sh/a.png')
			url.searchParams.set('x-pxid', pixelId)
			url.searchParams.set('Page', page)
			// A return visit must fetch again instead of reusing the document's image.
			url.searchParams.set('_', crypto.randomUUID())
			pixel.src = url.toString()
		} catch {
			// Analytics must not interrupt navigation or fail in restricted browsers.
		}
	}
}

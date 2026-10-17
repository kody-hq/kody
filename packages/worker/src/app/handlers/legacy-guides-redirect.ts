import { resolveLegacyDocSlug } from '#universal/docs-nav.ts'

/**
 * The docs lived under `/guides` before they became `/docs`. Every old URL
 * shape keeps resolving with a 308 (method-preserving, cacheable):
 *
 * - `/guides`, `/guides.md`, `/guides.json` → `/docs`, `/docs.md`, `/docs.json`
 * - `/guides/connect(.md|.json)` → `/docs/connect(.md|.json)`
 * - `/guides/:slug`, `:slug.md`, `:slug.json`, `:slug/og.png` → the same
 *   twin under `/docs/`, through `legacyDocSlugAliases` for merged docs.
 *
 * Query strings survive; a merged doc's HTML redirect carries the absorbing
 * heading as a fragment.
 */
export function resolveLegacyGuidesLocation(url: URL): string {
	const { pathname, search } = url
	if (pathname === '/guides') return `/docs${search}`
	if (pathname === '/guides.md') return `/docs.md${search}`
	if (pathname === '/guides.json') return `/docs.json${search}`

	const rest = pathname.startsWith('/guides/')
		? pathname.slice('/guides/'.length)
		: ''
	if (rest === '' || rest.startsWith('connect')) {
		return `/docs${rest ? `/${rest}` : ''}${search}`
	}

	const twinMatch = /^([^/.]+)(\.md|\.json|\/og\.png)?$/.exec(rest)
	if (!twinMatch) return `/docs/${rest}${search}`
	const alias = resolveLegacyDocSlug(twinMatch[1]!)
	const twin = twinMatch[2] ?? ''
	const fragment = twin === '' && alias.fragment ? `#${alias.fragment}` : ''
	return `/docs/${alias.slug}${twin}${search}${fragment}`
}

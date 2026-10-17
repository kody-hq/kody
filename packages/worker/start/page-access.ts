import {
	docsNav,
	resolveLegacyDocSlug,
	unadvertisedDocSlugs,
} from '../universal/docs-nav.ts'

const publicDocSlugs = new Set([
	...docsNav
		.filter((section) => !section.adminOnly)
		.flatMap((section) => section.items.map((item) => item.slug)),
	...unadvertisedDocSlugs,
])

/** Unknown guides require authorization until the catalog classifies them. */
export function isPublicDocSlug(slug: string): boolean {
	return publicDocSlugs.has(resolveLegacyDocSlug(slug).slug)
}

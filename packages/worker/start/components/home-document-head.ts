import type { ResolvedDocumentHead } from '#universal/document-head-contract.ts'
import {
	getHomeOgVariant,
	homeOgImagePath,
} from '#universal/home-og-variants.ts'

/** Apply a share variant to the server's base head without loading the whole page catalog. */
export function homeDocumentHead(
	head: ResolvedDocumentHead | undefined,
	og: unknown,
) {
	const variant = getHomeOgVariant(typeof og === 'string' ? og : undefined)
	if (!head?.canonicalUrl || !head.og || !variant) return head
	const image = new URL(homeOgImagePath(variant.id), head.canonicalUrl)
	const version = new URL(head.og.imageUrl).searchParams.get('v')
	if (version) image.searchParams.set('v', version)
	return {
		...head,
		description: variant.ogDescription,
		og: {
			title: variant.ogTitle,
			description: variant.ogDescription,
			imageUrl: image.href,
		},
	}
}

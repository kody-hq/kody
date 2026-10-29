import type { ResolvedDocumentHead } from '#universal/document-head-contract.ts'

/** Translate the existing head contract into TanStack Router head entries. */
export function documentHead(head: ResolvedDocumentHead | undefined) {
	if (!head) return { meta: [{ title: 'Not found' }] }
	const meta: Array<
		| { title: string }
		| { name: string; content: string }
		| { property: string; content: string }
	> = [{ title: head.title }]
	if (head.description)
		meta.push({ name: 'description', content: head.description })
	if (head.og) {
		meta.push(
			{ property: 'og:title', content: head.og.title },
			{ property: 'og:description', content: head.og.description },
			{ property: 'og:image', content: head.og.imageUrl },
			{ property: 'og:type', content: 'website' },
			{ name: 'twitter:card', content: 'summary_large_image' },
			{ name: 'twitter:title', content: head.og.title },
			{ name: 'twitter:description', content: head.og.description },
			{ name: 'twitter:image', content: head.og.imageUrl },
		)
		if (head.canonicalUrl)
			meta.push({ property: 'og:url', content: head.canonicalUrl })
	}
	return {
		meta,
		links: [
			...(head.canonicalUrl
				? [{ rel: 'canonical', href: head.canonicalUrl }]
				: []),
			...(head.links ?? []),
		],
	}
}

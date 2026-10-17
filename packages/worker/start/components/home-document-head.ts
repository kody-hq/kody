import {
	absolutizeDocumentHead,
	resolveDocumentHead,
	type ResolvedDocumentHead,
} from '#universal/document-head.ts'

/** OG selection changes the share card, not the homepage data cache. */
export function homeDocumentHead(
	head: ResolvedDocumentHead | undefined,
	og: unknown,
) {
	if (!head?.canonicalUrl) return head
	const search = typeof og === 'string' ? `?${new URLSearchParams({ og })}` : ''
	return absolutizeDocumentHead(
		resolveDocumentHead('home', '/', undefined, search),
		new URL(head.canonicalUrl).origin,
	)
}

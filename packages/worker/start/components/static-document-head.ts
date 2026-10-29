import { absolutizeDocumentHead } from '#universal/document-head-contract.ts'
import {
	resolveDocumentHead,
	type DocumentHeadKey,
} from '#universal/document-head-resolver.ts'
import { documentHead } from './document-head.ts'

/** Native file routes select their own metadata without a second URL matcher. */
export function staticDocumentHead(key: DocumentHeadKey) {
	return ({
		match,
		matches,
		params,
	}: {
		match: { pathname: string; context: unknown }
		matches: Array<{ loaderData?: unknown }>
		params: Record<string, string | undefined>
	}) => {
		const rootData = matches[0]?.loaderData
		const origin =
			rootData &&
			typeof rootData === 'object' &&
			'canonicalOrigin' in rootData &&
			typeof rootData.canonicalOrigin === 'string'
				? rootData.canonicalOrigin
				: undefined
		const context = match.context as { pageLocation?: { searchStr?: string } }
		const descriptor = resolveDocumentHead(
			key,
			match.pathname,
			undefined,
			context.pageLocation?.searchStr ?? '',
			params,
		)
		return documentHead(
			origin
				? absolutizeDocumentHead(descriptor, origin)
				: { title: descriptor.title, description: descriptor.description },
		)
	}
}

import { highlightBatchCacheRequest } from '../../worker/universal/highlight-cache-request.ts'
import type { HighlightSnippet } from '../../worker/universal/highlighted-code.ts'

export const highlightCacheName = 'kody-highlight-tokens'

const cacheOrigin = 'https://highlight-cache.local'

export function highlightCacheRequest(snippets: Array<HighlightSnippet>) {
	return highlightBatchCacheRequest(cacheOrigin, snippets)
}

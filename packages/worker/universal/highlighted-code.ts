/**
 * Serializable syntax-highlight payload. Origin (and the highlight worker)
 * produce this; the browser only paints it. Keep the wire shape stable —
 * `packages/highlight-worker` and `#app/highlight-code.ts` share it.
 */

const highlighterVersion = '2'

export const highlightPreClass = 'tanstack-highlight'

export type HighlightedSpan = {
	content: string
	style?: Record<string, string>
}

export type HighlightedCode = {
	code: string
	lang: string
	plain: boolean
	fg?: string
	bg?: string
	lines: Array<Array<HighlightedSpan>>
}

export type HighlightSnippet = {
	code: string
	lang?: string | null
}

export function highlightSnippetKey(snippet: HighlightSnippet) {
	const lang = snippet.lang?.trim().toLowerCase() ?? ''
	return JSON.stringify([highlighterVersion, lang, snippet.code])
}

export function plainHighlightedCode(
	code: string,
	lang?: string | null,
): HighlightedCode {
	return {
		code,
		lang: lang?.trim() || 'plaintext',
		plain: true,
		lines: [],
	}
}

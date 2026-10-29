import { parseKodyMarkdown } from '#universal/markdown.ts'
import { type BlockNode } from '@tanstack/markdown'
import { highlightCacheHeaderName } from '#universal/highlight-cache-header.ts'
import { highlightBatchCacheRequest } from '#universal/highlight-cache-request.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
	type HighlightSnippet,
} from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

export type HighlightEnv = {
	HIGHLIGHT?: Fetcher
}

export type HighlightOptions = {
	serverTiming?: Array<ServerTimingEntry>
}

type HighlightCacheDesc = 'hit' | 'worker' | 'miss' | 'fallback'

function recordHighlight(
	serverTiming: Array<ServerTimingEntry> | undefined,
	startedAt: number,
	desc: HighlightCacheDesc,
) {
	if (!serverTiming) return
	serverTiming.push({
		name: 'highlight',
		durationMs: Date.now() - startedAt,
		desc,
	})
}

const highlightOrigin = 'https://highlight.internal'
const originCacheOrigin = 'https://highlight-origin.local'
const originHighlightCacheName = 'kody-highlight-origin'

async function originHighlightCache() {
	if (typeof caches === 'undefined') return null
	return caches.open(originHighlightCacheName)
}

function originCacheRequest(snippets: Array<HighlightSnippet>) {
	return highlightBatchCacheRequest(originCacheOrigin, snippets)
}

function isHighlightedCode(value: unknown): value is HighlightedCode {
	if (typeof value !== 'object' || value === null) return false
	const item = value as HighlightedCode
	return (
		typeof item.code === 'string' &&
		typeof item.lang === 'string' &&
		typeof item.plain === 'boolean' &&
		Array.isArray(item.lines)
	)
}

async function readOriginCache(snippets: Array<HighlightSnippet>) {
	try {
		const cache = await originHighlightCache()
		if (!cache) return null
		const cached = await cache.match(await originCacheRequest(snippets))
		if (!cached?.ok) return null
		const body = (await cached.json()) as { results?: unknown }
		if (!Array.isArray(body.results)) return null
		if (body.results.length !== snippets.length) return null
		if (!body.results.every(isHighlightedCode)) return null
		return body.results
	} catch {
		return null
	}
}

async function writeOriginCache(
	snippets: Array<HighlightSnippet>,
	results: Array<HighlightedCode>,
) {
	try {
		const cache = await originHighlightCache()
		if (!cache) return
		await cache.put(
			await originCacheRequest(snippets),
			new Response(JSON.stringify({ results }), {
				headers: {
					'content-type': 'application/json',
					'cache-control': 'public, max-age=86400',
				},
			}),
		)
	} catch (error) {
		console.debug('highlight-origin-cache-write-failed', error)
	}
}

export async function highlightSnippets(
	env: HighlightEnv,
	snippets: Array<HighlightSnippet>,
	options?: HighlightOptions,
): Promise<Array<HighlightedCode>> {
	if (snippets.length === 0) return []

	const startedAt = Date.now()
	const cached = await readOriginCache(snippets)
	if (cached) {
		recordHighlight(options?.serverTiming, startedAt, 'hit')
		return cached
	}

	const highlight = env.HIGHLIGHT
	if (!highlight) {
		recordHighlight(options?.serverTiming, startedAt, 'fallback')
		return snippets.map((snippet) =>
			plainHighlightedCode(snippet.code, snippet.lang),
		)
	}

	try {
		const response = await highlight.fetch(`${highlightOrigin}/highlight`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ snippets }),
		})
		if (!response.ok) {
			throw new Error(`highlight worker ${response.status}`)
		}
		const body = (await response.json()) as { results?: unknown }
		if (
			!Array.isArray(body.results) ||
			body.results.length !== snippets.length
		) {
			throw new Error('highlight worker returned unexpected results')
		}
		if (!body.results.every(isHighlightedCode)) {
			throw new Error('highlight worker returned unexpected results')
		}
		await writeOriginCache(snippets, body.results)
		recordHighlight(
			options?.serverTiming,
			startedAt,
			response.headers.get(highlightCacheHeaderName) === 'hit'
				? 'worker'
				: 'miss',
		)
		return body.results
	} catch (error) {
		console.debug('highlight-binding-failed', error)
		recordHighlight(options?.serverTiming, startedAt, 'fallback')
		return snippets.map((snippet) =>
			plainHighlightedCode(snippet.code, snippet.lang),
		)
	}
}

function walkMarkdownTokens(
	nodes: Array<BlockNode>,
	fences: Array<HighlightSnippet>,
) {
	for (const node of nodes) {
		if (node.type === 'code') fences.push({ code: node.value, lang: node.lang })
		else if (node.type === 'list' || node.type === 'footnotes') {
			for (const item of node.items) walkMarkdownTokens(item.children, fences)
		} else if (
			'children' in node &&
			node.type !== 'paragraph' &&
			node.type !== 'heading'
		)
			walkMarkdownTokens(node.children, fences)
	}
}

export function collectMarkdownFences(
	markdown: string,
	firstParty = false,
): Array<HighlightSnippet> {
	const fences: Array<HighlightSnippet> = []
	walkMarkdownTokens(parseKodyMarkdown(markdown, firstParty).children, fences)
	return fences
}

export async function highlightMarkdownFences(
	env: HighlightEnv,
	markdown: string,
	options?: HighlightOptions & { firstParty?: boolean },
): Promise<Array<HighlightedCode>> {
	return highlightSnippets(
		env,
		collectMarkdownFences(markdown, options?.firstParty),
		options,
	)
}

export async function highlightJsonValue(
	env: HighlightEnv,
	value: unknown,
	options?: HighlightOptions,
): Promise<HighlightedCode> {
	const code = JSON.stringify(value, null, 2) ?? 'null'
	const [result] = await highlightSnippets(
		env,
		[{ code, lang: 'json' }],
		options,
	)
	return result ?? plainHighlightedCode(code, 'json')
}

export function uniqueHighlightSnippets(
	snippets: Array<HighlightSnippet>,
): Array<HighlightSnippet> {
	const seen = new Set<string>()
	const unique: Array<HighlightSnippet> = []
	for (const snippet of snippets) {
		const key = highlightSnippetKey(snippet)
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(snippet)
	}
	return unique
}

export function highlightResultsByKey(
	snippets: Array<HighlightSnippet>,
	results: Array<HighlightedCode>,
): Record<string, HighlightedCode> {
	const map: Record<string, HighlightedCode> = {}
	for (const [index, snippet] of snippets.entries()) {
		const result = results[index]
		if (!result) continue
		map[highlightSnippetKey(snippet)] = result
	}
	return map
}

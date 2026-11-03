import {
	highlightCacheHeaderName,
	highlightServiceOrigin,
} from '../../worker/universal/highlight-cache-header.ts'
import type {
	HighlightedCode,
	HighlightSnippet,
} from '../../worker/universal/highlighted-code.ts'
import { highlightCacheName, highlightCacheRequest } from './cache.ts'
import { handleHighlightHealthRequest } from './health.ts'
import { tokenizeSnippets } from './tokenize.ts'

type HighlightWorkerEnv = {
	APP_COMMIT_SHA?: string
}

function isSnippet(value: unknown): value is HighlightSnippet {
	if (typeof value !== 'object' || value === null) return false
	const snippet = value as { code?: unknown; lang?: unknown }
	if (typeof snippet.code !== 'string') return false
	return (
		snippet.lang === undefined ||
		snippet.lang === null ||
		typeof snippet.lang === 'string'
	)
}

// Far above what origin sends for one page; larger batches fall back to plain.
const maxSnippetsPerRequest = 1_000
const maxTotalSnippetChars = 2_000_000
const serviceHostname = new URL(highlightServiceOrigin).hostname

function parseSnippets(
	value: unknown,
): Array<HighlightSnippet> | 'too_large' | null {
	if (typeof value !== 'object' || value === null) return null
	const body = value as { snippets?: unknown }
	if (!Array.isArray(body.snippets)) return null
	if (body.snippets.length > maxSnippetsPerRequest) return 'too_large'
	if (!body.snippets.every(isSnippet)) return null
	let totalChars = 0
	for (const snippet of body.snippets) {
		totalChars += snippet.code.length + (snippet.lang?.length ?? 0)
		if (totalChars > maxTotalSnippetChars) return 'too_large'
	}
	return body.snippets
}

async function highlightTokenCache() {
	return caches.open(highlightCacheName)
}

async function readCachedResults(
	snippets: Array<HighlightSnippet>,
): Promise<Array<HighlightedCode> | null> {
	try {
		const cache = await highlightTokenCache()
		const cached = await cache.match(await highlightCacheRequest(snippets))
		if (!cached?.ok) return null
		const body = (await cached.json()) as { results?: unknown }
		if (!Array.isArray(body.results)) return null
		return body.results as Array<HighlightedCode>
	} catch {
		return null
	}
}

async function writeCachedResults(
	snippets: Array<HighlightSnippet>,
	results: Array<HighlightedCode>,
) {
	try {
		const cache = await highlightTokenCache()
		await cache.put(
			await highlightCacheRequest(snippets),
			new Response(JSON.stringify({ results }), {
				headers: {
					'content-type': 'application/json',
					'cache-control': 'public, max-age=86400',
				},
			}),
		)
	} catch (error) {
		console.debug('highlight-worker-cache-write-failed', error)
	}
}

const handler = {
	async fetch(request: Request, env: HighlightWorkerEnv) {
		const health = handleHighlightHealthRequest(request, env)
		if (health) return health

		const url = new URL(request.url)
		if (request.method !== 'POST' || url.pathname !== '/highlight') {
			return new Response('Not found', { status: 404 })
		}
		// Only the HIGHLIGHT service binding (which addresses the internal
		// origin) may tokenize; the public workers.dev URL serves /health only.
		if (url.hostname !== serviceHostname) {
			return new Response('Not found', { status: 404 })
		}

		let parsed: unknown
		try {
			parsed = await request.json()
		} catch {
			return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
		}
		const snippets = parseSnippets(parsed)
		if (!snippets) {
			return Response.json({ error: 'Expected { snippets }.' }, { status: 400 })
		}
		if (snippets === 'too_large') {
			return Response.json(
				{ error: 'Too many snippets or characters.' },
				{ status: 413 },
			)
		}

		const cached = await readCachedResults(snippets)
		if (cached) return highlightJsonResponse(cached, 'hit')

		const results = tokenizeSnippets(snippets)
		await writeCachedResults(snippets, results)
		return highlightJsonResponse(results, 'miss')
	},
} satisfies ExportedHandler<HighlightWorkerEnv>

function highlightJsonResponse(
	results: Array<HighlightedCode>,
	cache: 'hit' | 'miss',
) {
	return Response.json(
		{ results },
		{ headers: { [highlightCacheHeaderName]: cache } },
	)
}

export default handler

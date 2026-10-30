import { expect, test } from 'vitest'
import {
	collectMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { highlightCacheHeaderName } from '#universal/highlight-cache-header.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

function highlightedFixture(
	code: string,
	lang = 'typescript',
): HighlightedCode {
	return {
		code,
		lang,
		plain: false,
		lines: [
			[{ content: code, style: { color: '#111', '--highlight-dark': '#eee' } }],
		],
	}
}

test('collectMarkdownFences walks top-level and nested code tokens', () => {
	expect(
		collectMarkdownFences(
			['# Title', '', '```ts', 'const x = 1', '```', '', '- item', ''].join(
				'\n',
			),
		),
	).toEqual([{ code: 'const x = 1', lang: 'ts' }])

	expect(
		collectMarkdownFences(
			['> quote', '', '> ```json', '> {"ok": true}', '> ```'].join('\n'),
		),
	).toEqual([{ code: '{"ok": true}', lang: 'json' }])
})

test('highlightSnippets covers fallback, worker timings, key mapping, and worker errors', async () => {
	const fallbackTiming: Array<ServerTimingEntry> = []
	const fallback = await highlightSnippets(
		{},
		[{ code: 'const x = 1', lang: 'ts' }],
		{ serverTiming: fallbackTiming },
	)
	expect(fallback).toEqual([plainHighlightedCode('const x = 1', 'ts')])
	expect(fallbackTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'fallback' }),
	])

	const snippet = { code: 'const x = 1', lang: 'ts' as const }
	const fixture = highlightedFixture(snippet.code)
	const workerTiming: Array<ServerTimingEntry> = []
	const workerEnv = {
		HIGHLIGHT: {
			fetch: async () =>
				Response.json(
					{ results: [fixture] },
					{ headers: { [highlightCacheHeaderName]: 'hit' } },
				),
		} as unknown as Fetcher,
	}
	const workerResults = await highlightSnippets(workerEnv, [snippet], {
		serverTiming: workerTiming,
	})
	expect(workerResults).toEqual([fixture])
	expect(workerTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'worker' }),
	])
	expect(highlightResultsByKey([snippet], workerResults)).toEqual({
		[highlightSnippetKey(snippet)]: fixture,
	})
	expect(
		uniqueHighlightSnippets([snippet, snippet, { code: 'x', lang: 'txt' }]),
	).toEqual([snippet, { code: 'x', lang: 'txt' }])

	const missTiming: Array<ServerTimingEntry> = []
	const missEnv = {
		HIGHLIGHT: {
			fetch: async () =>
				Response.json(
					{ results: [fixture] },
					{ headers: { [highlightCacheHeaderName]: 'miss' } },
				),
		} as unknown as Fetcher,
	}
	expect(
		await highlightSnippets(missEnv, [snippet], { serverTiming: missTiming }),
	).toEqual([fixture])
	expect(missTiming).toEqual([
		expect.objectContaining({ name: 'highlight', desc: 'miss' }),
	])

	const errorEnv = {
		HIGHLIGHT: {
			fetch: async () => new Response('nope', { status: 503 }),
		} as unknown as Fetcher,
	}
	expect(
		await highlightSnippets(errorEnv, [{ code: 'const x = 1', lang: 'ts' }]),
	).toEqual([plainHighlightedCode('const x = 1', 'ts')])
})

test('collectMarkdownFences includes disclosure fences in render order', () => {
	expect(
		collectMarkdownFences(
			'<details>\n<summary>Example</summary>\n\n```ts\nconst x = 1\n```\n\n</details>\n\n```json\n{}\n```',
			true,
		),
	).toEqual([
		{ code: 'const x = 1', lang: 'ts' },
		{ code: '{}', lang: 'json' },
	])
})

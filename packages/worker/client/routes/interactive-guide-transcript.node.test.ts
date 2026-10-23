import { expect, test } from 'vitest'
import {
	collectTranscriptSnippets,
	executeTextReturn,
	searchTextReturn,
} from './interactive-guide-transcript.ts'

const sampleMemory = {
	id: 'mem-watch-login',
	subject: 'Favorite bot',
	summary: 'kody-bot is the favorite bot to watch.',
}

test('homepage search/execute returns keep memories as one-liners, not structured JSON', () => {
	const search = searchTextReturn({
		conversationId: 'conv-1',
		body: '# Search results\n\n1. **secret** `githubAccessToken`',
		memories: [sampleMemory],
	})
	expect(search).toContain('## Relevant memories')
	expect(search).toContain(
		'- **Favorite bot** — kody-bot is the favorite bot to watch.',
	)
	expect(search).not.toContain('"surfaced"')
	expect(search).not.toContain(sampleMemory.id)

	const execute = executeTextReturn({
		conversationId: 'conv-1',
		value: [{ title: 'kody-bot/lantern v1.4.0' }],
		memories: [sampleMemory],
	})
	expect(execute).toContain('## Relevant memories')
	expect(execute).toContain(
		'- **Favorite bot** — kody-bot is the favorite bot to watch.',
	)
	expect(execute).not.toContain('"surfaced"')
	expect(execute).not.toContain(sampleMemory.id)

	const snippets = collectTranscriptSnippets([
		{
			id: 'collect',
			kicker: 'Collect',
			title: 'Collect',
			lines: [
				{ role: 'user', text: 'skip me' },
				{ role: 'agent', text: 'skip me too' },
				{
					role: 'tools',
					tools: [
						{
							name: 'search',
							summary: 'look',
							note: 'note',
							inputs: [
								{ name: 'code', kind: 'code', lang: 'ts', value: '1 + 1' },
							],
							resultLang: 'json',
							result: '{"ok":true}',
						},
					],
				},
				{
					role: 'files',
					summary: 'clone',
					note: 'note',
					files: [
						{
							path: 'src/example.ts',
							summary: 'example',
							content: 'export const n = 1',
						},
					],
				},
			],
		},
	])
	expect(snippets).toEqual([
		{ code: '1 + 1', lang: 'ts' },
		{ code: '{"ok":true}', lang: 'json' },
		{ code: 'export const n = 1', lang: 'ts' },
	])
})

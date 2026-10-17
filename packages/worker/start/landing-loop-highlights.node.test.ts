import { QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
const load = vi.hoisted(() => vi.fn())
vi.mock('#start/server/landing-loop-highlights', () => ({
	loadLandingLoopHighlights: load,
}))
import { fetchLandingLoopHighlights } from './landing-loop-highlights.ts'
test('landing loop shares static highlight data across repeat mounts', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const highlights = {
		snippet: {
			code: 'const x=1',
			lang: 'ts',
			plain: false,
			lines: [[{ content: 'const', style: { color: '#d73a49' } }]],
		},
	}
	load.mockResolvedValue(highlights)
	expect(await fetchLandingLoopHighlights(client)).toEqual(highlights)
	expect(await fetchLandingLoopHighlights(client)).toEqual(highlights)
	expect(load).toHaveBeenCalledTimes(1)
	client.clear()
	load.mockRejectedValue(new Error('offline'))
	expect(await fetchLandingLoopHighlights(client)).toEqual({})
	client.clear()
})

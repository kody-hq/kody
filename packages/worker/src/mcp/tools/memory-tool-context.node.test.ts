import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	searchMemoryRecords: vi.fn(),
	acknowledgeSurfacedMemories: vi.fn(
		async (..._args: Array<unknown>) => undefined,
	),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	searchMemoryRecords: (...args: Array<unknown>) =>
		mockModule.searchMemoryRecords(...args),
	acknowledgeSurfacedMemories: (...args: Array<unknown>) =>
		mockModule.acknowledgeSurfacedMemories(...args),
}))

const {
	automaticMemorySingleListRankOneScore,
	formatSurfacedMemoriesMarkdown,
	loadRelevantMemoriesForTool,
	searchMemorySurfaceMinVectorScore,
} = await import('./memory-tool-context.ts')

const callerContext = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://heykody.dev',
	user: {
		userId: personIdFromStored('user-1'),
		email: 'user@example.com',
		displayName: 'User',
	},
})

function memory(
	id: string,
	score: number,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		category: 'workflow',
		status: 'active',
		subject: 'Search workflow',
		summary: 'Use ranked search.',
		details: '',
		tags: ['search'],
		sourceUris: [],
		dedupeKey: null,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
		lastAccessedAt: null,
		deletedAt: null,
		score,
		vectorScore: 0.8,
		...overrides,
	}
}

function loadMemories(
	query: string,
	matches: Array<ReturnType<typeof memory>>,
	extra: Partial<Parameters<typeof loadRelevantMemoriesForTool>[0]> = {},
	offline = false,
) {
	mockModule.searchMemoryRecords.mockResolvedValueOnce({
		matches,
		suppressedCount: 0,
		query,
		offline,
	})
	return loadRelevantMemoriesForTool({
		env: { APP_DB: {} } as Env,
		callerContext,
		conversationId: `conversation-${query}`,
		memoryContext: { query },
		...extra,
	})
}

const rankOne = automaticMemorySingleListRankOneScore

test('memory tool context filters weak matches and formats markdown', async () => {
	const filtered = await loadMemories(
		'ranked search',
		[
			memory('active-rank-one', rankOne),
			memory('active-rank-two', 1 / 62),
			memory('active-rank-three', 1 / 63),
			memory('archived-strong', 0.04, { status: 'archived' }),
		],
		{ acknowledgeSurfaced: false },
	)
	expect(filtered?.memories).toEqual(
		['active-rank-one', 'active-rank-two'].map((id) => ({
			id,
			subject: 'Search workflow',
			summary: 'Use ranked search.',
			scope: 'personal',
		})),
	)
	expect(mockModule.acknowledgeSurfacedMemories).not.toHaveBeenCalled()
	const [compactContent] = formatSurfacedMemoriesMarkdown(filtered)
	expect(compactContent?.text).toBe(
		[
			'## Relevant memories (personal)',
			'',
			'These are personal memories. Ask before copying any into an org package or other shared org resource.',
			'',
			'- **[personal]** **Search workflow** — Use ranked search.',
			'- **[personal]** **Search workflow** — Use ranked search.',
		].join('\n'),
	)

	const collapsed = await loadMemories('openai apps challenge', [
		memory('dup-first', rankOne, {
			dedupeKey: 'openai-apps-domain-challenge',
			subject: 'OpenAI Apps domain verification',
			summary: 'Challenge token is a static public asset.',
		}),
		memory('dup-second', 1 / 62, {
			dedupeKey: '  openai-apps-domain-challenge  ',
			subject: 'OpenAI Apps domain verification',
			summary: 'Challenge token is a static public asset.',
		}),
		memory('next-distinct', 1 / 63, {
			dedupeKey: 'prefilled-setup-urls',
			subject: 'Always prefill hosted setup URLs',
			summary: 'Give a prefilled secrets URL.',
		}),
		memory('null-key-one', 1 / 64, {
			subject: 'Null key one',
			summary: 'No shared key.',
		}),
	])
	expect(collapsed?.memories).toEqual([
		{
			id: 'dup-first',
			subject: 'OpenAI Apps domain verification',
			summary: 'Challenge token is a static public asset.',
			scope: 'personal',
		},
		{
			id: 'next-distinct',
			subject: 'Always prefill hosted setup URLs',
			summary: 'Give a prefilled secrets URL.',
			scope: 'personal',
		},
	])

	const untitled = await loadMemories('untitled habits', [
		memory('null-a', rankOne, {
			subject: 'Untitled habit A',
			summary: 'First untitled fact.',
		}),
		memory('null-b', 1 / 62, {
			dedupeKey: '   ',
			subject: 'Untitled habit B',
			summary: 'Second untitled fact.',
		}),
	])
	expect(untitled?.memories.map((entry) => entry.id)).toEqual([
		'null-a',
		'null-b',
	])
})

const belowFloor = searchMemorySurfaceMinVectorScore - 0.05

test('search auto-surface drops memories below the relevance floor', async () => {
	const unrelated = await loadMemories('convert a pdf to text', [
		memory('weak-one', rankOne, { vectorScore: belowFloor }),
		memory('weak-two', 1 / 62, { vectorScore: belowFloor }),
		memory('vector-miss', 1 / 63, { vectorScore: undefined }),
	])
	expect(unrelated).toEqual({
		memories: [],
		suppressedCount: 0,
		retrievalQuery: 'convert a pdf to text',
	})
	expect(formatSurfacedMemoriesMarkdown(unrelated)).toEqual([])

	const related = await loadMemories('write release notes', [
		memory('lexical-noise', rankOne, { vectorScore: belowFloor }),
		memory('release-notes', 1 / 62, {
			vectorScore: searchMemorySurfaceMinVectorScore,
		}),
		memory('also-weak', 1 / 63, { vectorScore: belowFloor }),
	])
	expect(related?.memories.map((entry) => entry.id)).toEqual(['release-notes'])

	const offline = await loadMemories(
		'local dev',
		[memory('hash-ranked', rankOne, { vectorScore: undefined })],
		{},
		true,
	)
	expect(offline?.memories.map((entry) => entry.id)).toEqual(['hash-ranked'])
})

test('search auto-surface with zero memories is unchanged', async () => {
	expect(await loadMemories('anything', [])).toEqual({
		memories: [],
		suppressedCount: 0,
		retrievalQuery: 'anything',
	})
})

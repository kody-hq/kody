import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as EntitlementsService from '#worker/entitlements/service.ts'
import * as SearchRateLimit from '#worker/search-rate-limit.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#worker/vectorize/embedding.ts'

const mockModule = vi.hoisted(() => {
	function createEmptySearchUnifiedResult() {
		return {
			matches: [],
			offline: false,
			intent: {
				normalizedQuery: 'skills',
				tokens: ['skills'],
				meaningfulTokens: ['skills'],
				phrases: [],
				task: { name: 'discover', confidence: 1 },
				actions: [],
				entities: [],
				constraints: [],
				confidence: 1,
			},
			telemetry: {
				intent: {
					task: 'discover',
					confidence: 1,
					entityCount: 0,
					actionCount: 0,
					constraintCount: 0,
					topEntities: [],
				},
				candidateCounts: {},
				topResultTypes: [],
			},
			phaseTimings: {
				queryUnderstandingMs: 0,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}
	function emptySearchRows() {
		return {
			packageRows: [],
			userSecretRows: [],
			userIntegrationRows: [],
			warnings: [],
			registry: { capabilitySpecs: {} },
		}
	}
	function memoryResult(retrievalQuery = 'skills') {
		return {
			memories: [],
			suppressedCount: 0,
			retrievalQuery,
		}
	}
	return {
		createEmptySearchUnifiedResult,
		emptySearchRows,
		memoryResult,
		resolvePublicUsername: vi.fn(async (..._args: Array<unknown>) => 'user'),
		resolvePackageIdentitySearch: vi.fn(async (..._args: Array<unknown>) => ({
			recognized: false,
		})),
		loadSearchRowsAndRegistry: vi.fn(async (..._args: Array<unknown>) =>
			emptySearchRows(),
		),
		searchUnified: vi.fn(async (..._args: Array<unknown>) =>
			createEmptySearchUnifiedResult(),
		),
		loadRelevantMemoriesForTool: vi.fn(async (..._args: Array<unknown>) =>
			memoryResult(),
		),
		consumeSearchRateLimit: vi.fn(async (..._args: Array<unknown>) => 'free'),
		getUserPlan: vi.fn(async (..._args: Array<unknown>) => 'free'),
	}
})

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		getUserPlan: (...args: Array<unknown>) => mockModule.getUserPlan(...args),
	}
})

vi.mock('#worker/identity/user-lookup.ts', () => ({
	resolvePublicUsername: (...args: Array<unknown>) =>
		mockModule.resolvePublicUsername(...args),
}))

vi.mock('./package-search-identity.ts', () => ({
	resolvePackageIdentitySearch: (...args: Array<unknown>) =>
		mockModule.resolvePackageIdentitySearch(...args),
}))

vi.mock('./search-loaders.ts', () => ({
	loadSearchRowsAndRegistry: (...args: Array<unknown>) =>
		mockModule.loadSearchRowsAndRegistry(...args),
}))

vi.mock('./search-core.ts', () => ({
	buildExactPackageSearchResult: () =>
		mockModule.createEmptySearchUnifiedResult(),
	searchUnified: (...args: Array<unknown>) => mockModule.searchUnified(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
		mockModule.loadRelevantMemoriesForTool(...args),
	acknowledgeToolMemories: async () => undefined,
	buildMemoryRetrievalQuery: (memoryContext?: { query?: string }) =>
		memoryContext?.query?.trim() ?? '',
}))

vi.mock('#worker/search-rate-limit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SearchRateLimit>()
	return {
		...actual,
		consumeSearchRateLimit: (...args: Array<unknown>) =>
			mockModule.consumeSearchRateLimit(...args),
	}
})

const { executeSearchList } = await import('./search-execution.ts')

type EmbedInput = {
	embedText?: (text: string) => Promise<Array<number>>
	query: string
	memoryContext?: { query?: string }
}

function search(
	env: Env,
	overrides: Partial<Parameters<typeof executeSearchList>[0]> = {},
) {
	return executeSearchList({
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			user: {
				userId: ownerIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
		} as never,
		conversationId: 'conv-search',
		query: 'skills',
		limit: 15,
		userId: ownerIdFromStored('user-1'),
		includeHiddenPackages: false,
		...overrides,
	})
}

function aiEnv(run: (...args: Array<unknown>) => Promise<unknown>) {
	return {
		SENTRY_ENVIRONMENT: 'production',
		AI: { run },
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return { matches: [] }
			},
		},
		APP_DB: {},
	} as unknown as Env
}

function gate() {
	let release = () => {}
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

test('executeSearchList embeds each distinct text once and starts the query embedding before rows resolve', async () => {
	const embedTexts: Array<string> = []
	const rows = gate()
	mockModule.loadSearchRowsAndRegistry.mockImplementationOnce(async () => {
		await rows.promise
		return mockModule.emptySearchRows()
	})
	mockModule.loadRelevantMemoriesForTool.mockImplementation(
		async (...args: Array<unknown>) => {
			const input = args[0] as EmbedInput
			const text = input.memoryContext?.query ?? 'skills'
			await input.embedText?.(text)
			return mockModule.memoryResult(text)
		},
	)
	mockModule.searchUnified.mockImplementation(
		async (...args: Array<unknown>) => {
			const input = args[0] as EmbedInput
			await input.embedText?.('skills')
			return mockModule.createEmptySearchUnifiedResult()
		},
	)
	const env = aiEnv(async (...args) => {
		const input = args[1] as { text?: unknown }
		const batch = Array.isArray(input.text)
			? input.text.map(String)
			: [String(input.text ?? '')]
		embedTexts.push(...batch)
		return {
			data: batch.map((text) => deterministicEmbedding(text)),
			shape: [batch.length, CAPABILITY_EMBEDDING_DIMENSIONS],
		}
	})

	const searchPromise = search(env, { memoryQuery: 'skills' })
	await expect.poll(() => embedTexts).toEqual(['skills'])
	rows.release()
	await searchPromise
	expect(embedTexts).toEqual(['skills'])

	embedTexts.length = 0
	await search(env, { memoryContext: { query: 'draft an email' } })
	expect([...embedTexts].sort()).toEqual(['draft an email', 'skills'])
})

test('executeSearchList does not leak an unhandled rejection when the ranking embedding fails during row load', async () => {
	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		const rows = gate()
		const embedStarted = gate()
		mockModule.loadSearchRowsAndRegistry.mockImplementation(async () => {
			await rows.promise
			return mockModule.emptySearchRows()
		})
		mockModule.searchUnified.mockImplementation(
			async (...args: Array<unknown>) => {
				const input = args[0] as EmbedInput
				await input.embedText?.(input.query)
				return mockModule.createEmptySearchUnifiedResult()
			},
		)
		const env = aiEnv(async () => {
			embedStarted.release()
			throw new Error('Workers AI unavailable')
		})

		const searchPromise = search(env, { memoryQuery: 'skills' })
		await embedStarted.promise
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
		rows.release()
		await expect(searchPromise).rejects.toThrow('Workers AI unavailable')
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('executeSearchList does not prefetch an embedding for domain-overview or index queries', async () => {
	const run = vi.fn(async () => {
		throw new Error('Workers AI should not run for overview search')
	})
	const env = aiEnv(run)
	await search(env, { query: 'what can kody do' })
	await search(env, { query: '' })
	expect(run).not.toHaveBeenCalled()
})

test('executeSearchList reads the Jev plan fresh while the rate limit runs', async () => {
	const rateLimit = gate()
	mockModule.consumeSearchRateLimit.mockImplementationOnce(async () => {
		await rateLimit.promise
		return 'free'
	})
	mockModule.getUserPlan.mockResolvedValueOnce('pro')
	const env = { APP_DB: {}, WRANGLER_IS_LOCAL_DEV: 'true' } as unknown as Env
	const searching = search(env)
	await vi.waitFor(() => {
		expect(mockModule.getUserPlan).toHaveBeenCalledTimes(1)
	})
	rateLimit.release()
	await searching
	expect(mockModule.searchUnified).toHaveBeenCalledWith(
		expect.objectContaining({ jevRerankPlanEligible: true }),
	)

	mockModule.searchUnified.mockClear()
	mockModule.getUserPlan.mockRejectedValueOnce(new Error('d1 blip'))
	await search(env, { conversationId: 'conv-search-plan-blip' })
	expect(mockModule.searchUnified).toHaveBeenCalledTimes(1)
	expect(mockModule.searchUnified).not.toHaveBeenCalledWith(
		expect.objectContaining({ jevRerankPlanEligible: true }),
	)
})

test('executeSearchList fails closed before ranking when the abuse rate limit rejects', async () => {
	mockModule.consumeSearchRateLimit.mockRejectedValueOnce(
		new SearchRateLimit.SearchRateLimitError({
			window: 'burst',
			retryAfterSeconds: 60,
			limit: 80,
			plan: 'free',
		}),
	)
	const embed = vi.fn(async () => ({
		data: [deterministicEmbedding('should-not-embed')],
		shape: [1, CAPABILITY_EMBEDDING_DIMENSIONS],
	}))

	await expect(search(aiEnv(embed))).rejects.toMatchObject({
		code: 'rate_limited',
		window: 'burst',
	})
	expect(mockModule.searchUnified).not.toHaveBeenCalled()
})

test('executeSearchList pairs team org OwnerId with blank entitlement email', async () => {
	const teamOrgId = 'b'.repeat(64) as ReturnType<typeof ownerIdFromStored>
	const actorId = ownerIdFromStored('user-1')
	mockModule.getUserPlan.mockResolvedValueOnce('max')
	mockModule.consumeSearchRateLimit.mockResolvedValueOnce('max')
	await search(
		{ APP_DB: {}, WRANGLER_IS_LOCAL_DEV: 'true' } as unknown as Env,
		{
			userId: teamOrgId,
			callerContext: {
				baseUrl: 'https://example.com',
				user: {
					userId: actorId,
					email: 'teammate@example.com',
					displayName: 'Teammate',
					username: 'teammate',
				},
				request: {
					org: {
						id: teamOrgId,
						slug: 'acme',
						kind: 'team',
						role: 'member',
					},
				},
			} as never,
		},
	)
	expect(mockModule.getUserPlan).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: teamOrgId, email: null }),
	)
	expect(mockModule.consumeSearchRateLimit).toHaveBeenCalledWith(
		expect.objectContaining({ userId: teamOrgId, email: null }),
	)
})

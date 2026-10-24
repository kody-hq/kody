import { type z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	buildMemoryRetrievalQuery,
	loadRelevantMemoriesForTool,
	type MemoryToolSummary,
} from '#mcp/tools/memory-tool-context.ts'
import { type EmbedTextFn } from '#worker/vectorize/embedding.ts'

import {
	SEARCH_MEMORY_ENRICHMENT_BUDGET_MS,
	memoryEnrichmentSkippedWarning,
} from './search-constants.ts'
import { elapsedMs, settleWithBudget } from './search-timing.ts'
import { type SearchMemoryEnrichmentSettlement } from './search-types.ts'
import { type memoryContextInputField } from './tool-call-context.ts'

export function resolveSearchMemoryContext(input: {
	query?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
}) {
	if (input.memoryContext !== undefined) {
		return input.memoryContext
	}

	const query = input.query?.trim() ?? ''
	return query.length > 0 ? { query } : undefined
}

export function launchSearchMemoryEnrichment(input: {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	query?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
	embedText?: EmbedTextFn
}): {
	promise: Promise<MemoryToolSummary | null>
	launchedAtMs: number
} | null {
	const userId = input.callerContext.user?.userId ?? null
	const memoryContext = resolveSearchMemoryContext({
		query: input.query,
		memoryContext: input.memoryContext,
	})
	if (!userId || !buildMemoryRetrievalQuery(memoryContext)) return null
	const launchedAtMs = performance.now()
	const promise = loadRelevantMemoriesForTool({
		env: input.env,
		callerContext: input.callerContext,
		conversationId: input.conversationId,
		memoryContext,
		acknowledgeSurfaced: false,
		...(input.embedText ? { embedText: input.embedText } : {}),
	})
	void promise.catch(() => {})
	return { promise, launchedAtMs }
}

export async function settleSearchMemoryEnrichment(input: {
	promise: Promise<MemoryToolSummary | null>
	launchedAtMs?: number
	budgetMs?: number
}): Promise<SearchMemoryEnrichmentSettlement> {
	const waitStartedAt = performance.now()
	const launchedAtMs = input.launchedAtMs ?? waitStartedAt
	const budgetMs = input.budgetMs ?? SEARCH_MEMORY_ENRICHMENT_BUDGET_MS
	const settlement = await settleWithBudget(
		input.promise,
		budgetMs,
		launchedAtMs,
	)
	const memoryEnrichmentWaitMs = elapsedMs(waitStartedAt)
	const memoryEnrichmentMs = settlement.durationMs

	if (!settlement.ok) {
		console.warn(
			JSON.stringify({
				message: 'search memory enrichment skipped',
				reason: settlement.timedOut ? 'timeout' : 'failure',
				budgetMs,
				waitedMs: memoryEnrichmentWaitMs,
				launchToSettleMs: memoryEnrichmentMs,
				...(settlement.failed
					? {
							error:
								settlement.error instanceof Error
									? settlement.error.message
									: String(settlement.error),
						}
					: {}),
			}),
		)
		return {
			warnings: [memoryEnrichmentSkippedWarning],
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryEnrichmentTimedOut: settlement.timedOut,
				memoryEnrichmentFailed: settlement.failed,
			},
		}
	}

	const memoryToolContext = settlement.value
	if (!memoryToolContext || memoryToolContext.memories.length === 0) {
		return {
			...(memoryToolContext
				? {
						memories: {
							surfaced: memoryToolContext.memories,
							suppressedCount: memoryToolContext.suppressedCount,
							retrievalQuery: memoryToolContext.retrievalQuery,
						},
					}
				: {}),
			warnings: [],
			phaseTimings: {
				memoryEnrichmentMs,
				memoryEnrichmentWaitMs,
				memoryEnrichmentTimedOut: false,
				memoryEnrichmentFailed: false,
			},
		}
	}

	return {
		memories: {
			surfaced: memoryToolContext.memories,
			suppressedCount: memoryToolContext.suppressedCount,
			retrievalQuery: memoryToolContext.retrievalQuery,
		},
		warnings: [],
		phaseTimings: {
			memoryEnrichmentMs,
			memoryEnrichmentWaitMs,
			memoryEnrichmentTimedOut: false,
			memoryEnrichmentFailed: false,
		},
	}
}

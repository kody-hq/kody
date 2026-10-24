import { expect, test, vi } from 'vitest'
import {
	reconcileSearchPhaseTimings,
	runWithSearchDeadline,
	SearchDeadlineError,
} from './search-timing.ts'

test('runWithSearchDeadline returns results that finish in time and rejects hung work', async () => {
	await expect(
		runWithSearchDeadline(async () => 'ranked', 1_000),
	).resolves.toBe('ranked')

	vi.useFakeTimers()
	try {
		let runSignal: AbortSignal | undefined
		const settled = runWithSearchDeadline((signal) => {
			runSignal = signal
			return new Promise(() => {})
		}, 1_000).catch((error: unknown) => error)
		expect(runSignal?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		const error = await settled
		expect(error).toBeInstanceOf(SearchDeadlineError)
		expect(runSignal?.aborted).toBe(true)
		expect(runSignal?.reason).toBe(error)
		expect((error as Error).message).toContain(
			'Search did not finish within 1s, so Kody stopped waiting before the MCP request timed out.',
		)
	} finally {
		vi.useRealTimers()
	}
})

test('reconcileSearchPhaseTimings sums exclusive tiles and leaves overlapping detail out of exclusiveMs', () => {
	const reconciled = reconcileSearchPhaseTimings({
		durationMs: 12389,
		phaseTimings: {
			queryUnderstandingMs: 0,
			candidateGenerationMs: 58,
			rerankingMs: 89,
			queryEmbeddingMs: 0,
			capabilityCandidatesMs: 58,
			packageCandidatesMs: 55,
			rowAndRegistryLoadMs: 1967,
			memoryEnrichmentMs: 2114,
			memoryEnrichmentWaitMs: 0,
			formattingMs: 0,
			usernameLookupMs: 12,
			identityResolutionMs: 8,
			loadAndRankMs: 2114,
			searchUnifiedMs: 147,
			waitingItemsMs: 4000,
			firstSearchStampMs: 40,
			onboardingNoticeMs: 80,
		},
	})

	expect(reconciled.exclusiveMs).toBe(12 + 8 + 2114 + 40 + 80 + 4000 + 0)
	expect(reconciled.unaccountedMs).toBe(
		12389 - (12 + 8 + 2114 + 40 + 80 + 4000),
	)
	expect(reconciled.loadAndRankMs).toBe(2114)
	expect(reconciled.memoryEnrichmentMs).toBe(2114)
})

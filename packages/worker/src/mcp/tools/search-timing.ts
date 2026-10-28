import { type ServerTimingEntry } from '#worker/server-timing.ts'

import { SEARCH_DEADLINE_MS } from './search-constants.ts'
import {
	type SearchPhaseTimings,
	type SearchTelemetry,
} from './search-types.ts'

export function elapsedMs(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt))
}

/**
 * Request-scoped Server-Timing phases for list-mode ranked search. Same
 * `{ name, durationMs }` shape as execute. `jevRerank` is included when the
 * flag path ran (applied, fallback-*, or a flag-on skip). Other
 * already-collected millisecond tiles map when present.
 */
const searchServerTimingPhases = [
	['rateLimit', 'rateLimitMs'],
	['usernameLookup', 'usernameLookupMs'],
	['identityResolution', 'identityResolutionMs'],
	['rowAndRegistryLoad', 'rowAndRegistryLoadMs'],
	['queryUnderstanding', 'queryUnderstandingMs'],
	['candidateGeneration', 'candidateGenerationMs'],
	['queryEmbedding', 'queryEmbeddingMs'],
	['loadAndRank', 'loadAndRankMs'],
	['reranking', 'rerankingMs'],
	['memoryEnrichment', 'memoryEnrichmentMs'],
	['formatting', 'formattingMs'],
	['waitingItems', 'waitingItemsMs'],
	['unaccounted', 'unaccountedMs'],
] as const satisfies ReadonlyArray<readonly [string, keyof SearchPhaseTimings]>

export function toSearchServerTiming(input: {
	phaseTimings: Partial<SearchPhaseTimings>
	jevRerank?: SearchTelemetry['jevRerank'] | null
}): Array<ServerTimingEntry> {
	const entries: Array<ServerTimingEntry> = []
	for (const [name, key] of searchServerTimingPhases) {
		const durationMs = input.phaseTimings[key]
		if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
			entries.push({ name, durationMs })
		}
		if (name === 'reranking') {
			const jevDurationMs = input.phaseTimings.jevRerankMs
			if (
				input.jevRerank &&
				typeof jevDurationMs === 'number' &&
				Number.isFinite(jevDurationMs)
			) {
				entries.push({ name: 'jevRerank', durationMs: jevDurationMs })
			}
		}
	}
	return entries
}

/**
 * Exclusive tiles that partition search wall clock. Overlapping detail
 * phases (memory, candidate plugins) are published beside
 * these and must not be summed into `exclusiveMs`.
 */
export const searchExclusivePhaseKeys = [
	'rateLimitMs',
	'usernameLookupMs',
	'identityResolutionMs',
	'loadAndRankMs',
	'entityResolveMs',
	'firstSearchStampMs',
	'onboardingNoticeMs',
	'waitingItemsMs',
	'formattingMs',
] as const satisfies ReadonlyArray<keyof SearchPhaseTimings>

export function reconcileSearchPhaseTimings<
	T extends Partial<SearchPhaseTimings>,
>(input: {
	durationMs: number
	phaseTimings: T
}): T & Pick<SearchPhaseTimings, 'exclusiveMs' | 'unaccountedMs'> {
	let exclusiveMs = 0
	for (const key of searchExclusivePhaseKeys) {
		const value = input.phaseTimings[key]
		if (typeof value === 'number') exclusiveMs += value
	}
	// List mode folds registry load into `loadAndRankMs`. Entity lookups
	// have no load-and-rank wave, so the registry read is its own tile.
	if (
		typeof input.phaseTimings.loadAndRankMs !== 'number' &&
		typeof input.phaseTimings.rowAndRegistryLoadMs === 'number'
	) {
		exclusiveMs += input.phaseTimings.rowAndRegistryLoadMs
	}
	return {
		...input.phaseTimings,
		exclusiveMs,
		unaccountedMs: Math.max(0, input.durationMs - exclusiveMs),
	}
}

export class SearchDeadlineError extends Error {
	constructor(deadlineMs: number) {
		super(
			`Search did not finish within ${String(Math.round(deadlineMs / 1000))}s, so Kody stopped waiting before the MCP request timed out. Retry once; if it repeats, use a shorter query or pass "domain" to narrow the search.`,
		)
		this.name = 'SearchDeadlineError'
	}
}

/**
 * Reject with {@link SearchDeadlineError} when `run` outlives `deadlineMs`,
 * and abort the signal handed to `run` so the abandoned search stops at its
 * next checkpoint (and aborts in-flight Jev calls) instead of finishing
 * unobserved work and side effects while the caller retries.
 */
export async function runWithSearchDeadline<T>(
	run: (signal: AbortSignal) => Promise<T>,
	deadlineMs: number = SEARCH_DEADLINE_MS,
): Promise<T> {
	const deadline = new AbortController()
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			run(deadline.signal),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					const error = new SearchDeadlineError(deadlineMs)
					reject(error)
					deadline.abort(error)
				}, deadlineMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

export async function settleWithBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
	launchedAtMs: number = performance.now(),
): Promise<
	| { ok: true; value: T; durationMs: number; timedOut: false; failed: false }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: true
			failed: false
	  }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: false
			failed: true
			error: unknown
	  }
> {
	const remainingMs = Math.max(0, budgetMs - (performance.now() - launchedAtMs))
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const raced = await Promise.race([
			promise.then(
				(value) => ({ status: 'fulfilled' as const, value }) as const,
				(error: unknown) => ({ status: 'rejected' as const, error }) as const,
			),
			new Promise<{ status: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => {
					resolve({ status: 'timeout' })
				}, remainingMs)
			}),
		])
		const durationMs = elapsedMs(launchedAtMs)
		if (raced.status === 'timeout') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: true,
				failed: false,
			}
		}
		if (raced.status === 'rejected') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: false,
				failed: true,
				error: raced.error,
			}
		}
		return {
			ok: true,
			value: raced.value,
			durationMs,
			timedOut: false,
			failed: false,
		}
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

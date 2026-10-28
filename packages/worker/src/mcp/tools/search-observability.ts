/**
 * Measurement-only Analytics Engine points for MCP `search` wall clock.
 *
 * Not a `recordUsage()` event and not a UWD surface. This dataset answers
 * "is search slow this hour?" and "which exclusive tile grew?".
 * No user, conversation, or query text.
 *
 * Production dataset `kody_mcp_search_events` (preview:
 * `kody_mcp_search_events_preview`). Binding `MCP_SEARCH_EVENTS` on origin
 * and platform (where MCP search runs). Recording is a no-op without the
 * binding and never throws.
 *
 * ```sql
 * SELECT
 *   quantile(0.5)(double1) AS p50_ms,
 *   quantile(0.95)(double1) AS p95_ms,
 *   avg(double2) AS avg_unaccounted_ms,
 *   SUM(_sample_interval) AS calls
 * FROM kody_mcp_search_events
 * WHERE timestamp > NOW() - INTERVAL '1' HOUR
 * ```
 */

import { type SearchPhaseTimings } from './search-types.ts'

export type SearchObservabilityMode = 'list' | 'entity' | 'entity-batch'

export type SearchObservabilityEnv = {
	MCP_SEARCH_EVENTS?: AnalyticsEngineDataset
}

export const searchObservabilityTelemetryIndex = 'mcp_search'

export type SearchObservabilityPoint = {
	outcome: 'success' | 'failure'
	mode: SearchObservabilityMode
	durationMs: number
	phaseTimings?: Partial<SearchPhaseTimings>
	task?: string
	intentConfidence?: number
	responseTrimmed?: boolean
	trimmedMatchCount?: number
	offline?: boolean
	/** Stage-2 Jev outcome; empty when not a ranked list search. */
	jevOutcome?: string
	/** Short fallback-error reason; empty when not a Jev fallback-error. */
	jevErrorReason?: string
	candidatesBeforeJev?: number
	candidatesAfterJev?: number
	jevDroppedCount?: number
	jevMeanConfidence?: number
	jevDurationMs?: number
	/** Encoded top-1 match type for cohort mix charts; -1 when unknown. */
	top1TypeCode?: number
	/** Score `AI.run` count; -1 when the Jev stage did not attempt. */
	jevAiCallCount?: number
	/** Summed prompt/input tokens; -1 when unused or omitted. */
	jevInputTokens?: number
	/** Summed completion/output tokens; -1 when unused or omitted. */
	jevOutputTokens?: number
}

const searchTop1TypeCodes = {
	capability: 1,
	guide: 2,
	package: 3,
	'mcp-server': 4,
	integration: 5,
	secret: 6,
	domain: 7,
} as const

/** Stable numeric code for top-1 match type mix charts; -1 when unknown. */
export function encodeSearchTop1Type(type: string | null | undefined): number {
	if (!type) return -1
	return searchTop1TypeCodes[type as keyof typeof searchTop1TypeCodes] ?? -1
}

function numericPhase(
	phaseTimings: Partial<SearchPhaseTimings> | undefined,
	key: keyof SearchPhaseTimings,
): number {
	const value = phaseTimings?.[key]
	return typeof value === 'number' ? value : 0
}

/**
 * Record one search-duration data point. Synchronous, nonthrowing, and a
 * no-op when the dedicated Analytics Engine binding is absent.
 */
export function recordSearchObservabilityEvent(
	env: SearchObservabilityEnv,
	input: SearchObservabilityPoint,
): void {
	try {
		env.MCP_SEARCH_EVENTS?.writeDataPoint({
			indexes: [searchObservabilityTelemetryIndex],
			blobs: [
				input.outcome,
				input.mode,
				input.task ?? '',
				input.responseTrimmed ? 'trimmed' : 'intact',
				input.offline ? 'offline' : 'online',
				'n/a', // blob6 reserved (formerly the jev-search-rerank flag cohort); keep positions stable.
				input.jevOutcome ?? '',
				input.jevErrorReason ?? '',
			],
			doubles: [
				input.durationMs,
				numericPhase(input.phaseTimings, 'unaccountedMs'),
				numericPhase(input.phaseTimings, 'loadAndRankMs'),
				numericPhase(input.phaseTimings, 'waitingItemsMs'),
				numericPhase(input.phaseTimings, 'memoryEnrichmentMs'),
				numericPhase(input.phaseTimings, 'rowAndRegistryLoadMs'),
				-1, // double7 reserved (formerly retrieversMs); keep positions stable.
				typeof input.intentConfidence === 'number'
					? input.intentConfidence
					: -1,
				input.trimmedMatchCount ?? 0,
				input.candidatesBeforeJev ?? -1,
				input.candidatesAfterJev ?? -1,
				input.jevDroppedCount ?? -1,
				typeof input.jevMeanConfidence === 'number'
					? input.jevMeanConfidence
					: -1,
				input.jevDurationMs ?? -1,
				input.top1TypeCode ?? -1,
				input.jevAiCallCount ?? -1,
				input.jevInputTokens ?? -1,
				input.jevOutputTokens ?? -1,
			],
		})
	} catch (error) {
		console.warn('mcp-search-event-failed', error)
	}
}

import { type searchCapabilities } from '#mcp/capabilities/capability-search.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type MemoryToolSummary } from '#mcp/tools/memory-tool-context.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { type PackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { type PackageReadmeSnippet } from '#worker/package-registry/package-readme.ts'
import { type listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

import {
	type JevSearchRerankOutcome,
	type SearchMatch,
} from './search-format-types.ts'
import { type SearchIntent } from './understand-search-query.ts'

export type { JevSearchRerankOutcome }

export type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	listingAhead: boolean | null
	projection: PackageSearchProjection
	readmeSnippet?: PackageReadmeSnippet | null
	hydrate?: () => Promise<{
		projection: PackageSearchProjection
		readmeSnippet: PackageReadmeSnippet | null
	}>
}

export type OptionalSearchRowsResult = {
	packageRows: Array<PackageSearchRow>
	userSecretRows: Array<SecretSearchRow>
	userIntegrationRows: Array<JoinedIntegration>
	warnings: Array<string>
}

export type LoadedPackageRows =
	| Array<PackageSearchRow>
	| BuildSavedPackageSearchRowsResult

export type SearchScoreComponents = {
	base: number
	lexical: number
	vector: number
	entityMatch: number
	providerEntityAffinity: number
	actionMatch: number
	taskAffinity: number
	appAvailability: number
	wrapperWorkflow: number
	constraint: number
	final: number
}

export type SearchCandidate = {
	match: SearchMatch
	type: SearchMatch['type']
	id: string
	title: string
	searchFields: Array<string>
	identityFields?: Array<string>
	providerIdentityFields?: Array<string>
	/** Saved-package identity used to recognize wrappers for synthesized providers. */
	packageIdentityFields?: Array<string>
	synthesizedProviderKey?: string
	scoreComponents: SearchScoreComponents
}

export type SearchTelemetry = {
	intent: {
		task: SearchIntent['task']['name']
		confidence: number
		entityCount: number
		actionCount: number
		constraintCount: number
		topEntities: Array<{
			type: string
			id: string
			confidence: number
		}>
	}
	candidateCounts: Partial<Record<SearchMatch['type'], number>>
	topResultTypes: Array<SearchMatch['type']>
	trimmedMatchCount?: number
	responseTrimmed?: boolean
	jevRerank?: {
		/**
		 * Always true: the Jev stage runs on every ranked search (plan and
		 * necessity decide `outcome`). Kept for search diagnostics readers.
		 */
		enabled: true
		outcome: JevSearchRerankOutcome
		candidatesBefore: number
		candidatesAfter: number
		droppedCount: number
		meanConfidence: number | null
		top1Type: SearchMatch['type'] | null
		/**
		 * Adaptive keep path after Jev Score (`kept-high` |
		 * `kept-lowered` | `kept-identity` | `empty`). Present when Score
		 * ran successfully.
		 */
		keepPath?: 'kept-high' | 'kept-lowered' | 'kept-identity' | 'empty'
		/** Present only when `outcome` is `fallback-error`. */
		errorReason?: string
		/** Present when the Jev stage ran or attempted. */
		model?: 'typesafe/jev'
		/** Score `AI.run` count (one per question batch). */
		aiCallCount?: number
		usage?: {
			inputTokens: number | null
			outputTokens: number | null
		}
	}
}

export type SearchPhaseTimings = {
	queryUnderstandingMs: number
	candidateGenerationMs: number
	rerankingMs: number
	jevRerankMs?: number
	formattingMs?: number
	rowAndRegistryLoadMs?: number
	queryEmbeddingMs?: number
	capabilityCandidatesMs?: number
	packageCandidatesMs?: number
	memoryEnrichmentMs?: number
	memoryEnrichmentWaitMs?: number
	memoryAcknowledgementMs?: number
	memoryEnrichmentTimedOut?: boolean
	memoryAcknowledgementTimedOut?: boolean
	memoryEnrichmentFailed?: boolean
	memoryAcknowledgementFailed?: boolean
	waitingItemsTimedOut?: boolean
	onboardingNoticeTimedOut?: boolean
	/**
	 * Exclusive wall-clock tiles. These do not overlap, so summing them and
	 * comparing to `durationMs` is how an operator reconciles the published
	 * phases against tool wall clock. Nested/overlapping detail phases
	 * (memory, candidate plugins) stay beside them and must not
	 * be added into `exclusiveMs`.
	 */
	rateLimitMs?: number
	usernameLookupMs?: number
	identityResolutionMs?: number
	loadAndRankMs?: number
	searchUnifiedMs?: number
	entityResolveMs?: number
	firstSearchStampMs?: number
	onboardingNoticeMs?: number
	waitingItemsMs?: number
	exclusiveMs?: number
	unaccountedMs?: number
}

export type SearchGuidanceContext = {
	query: string
	intent: SearchIntent
	matches: Array<SearchMatch>
}

export type SearchCapabilityMatch = Awaited<
	ReturnType<typeof searchCapabilities>
>['matches'][number]

export type SearchUnifiedResult = {
	matches: Array<SearchMatch>
	offline: boolean
	intent: SearchIntent
	telemetry: SearchTelemetry
	phaseTimings: SearchPhaseTimings
	guidance?: string
}

export type BuildSavedPackageSearchRowsResult = {
	rows: Array<PackageSearchRow>
	warnings: Array<string>
}

export type SearchMemoryEnrichmentSettlement = {
	memories?: {
		surfaced: MemoryToolSummary['memories']
		suppressedCount: number
		retrievalQuery: string
	}
	warnings: Array<string>
	phaseTimings: Pick<
		SearchPhaseTimings,
		| 'memoryEnrichmentMs'
		| 'memoryEnrichmentWaitMs'
		| 'memoryAcknowledgementMs'
		| 'memoryEnrichmentTimedOut'
		| 'memoryAcknowledgementTimedOut'
		| 'memoryEnrichmentFailed'
		| 'memoryAcknowledgementFailed'
	>
}

export type SearchRowsAndRegistry = OptionalSearchRowsResult & {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}

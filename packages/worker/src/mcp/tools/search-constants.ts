export const charsPerToken = 4
export const maxTokens = 6_000
/** Official-guide heading sections must stay under this budget (`kody-custom/no-oversized-guide-section`). */
export const maxChars = maxTokens * charsPerToken
export const defaultSearchLimit = 15
export const domainBrowseDefaultLimit = 100
export const defaultMaxResponseSize = 4_000
export const topCapabilityInlineCallShapeCount = 3
/**
 * Max length for an inlined package-export type definition on a high-
 * confidence ranked hit (same budget family as capability call shapes).
 */
export const inlineExportCallContractTypeMaxLength = 500
/**
 * Hybrid `scoreComponents.final` gap (top1 − top2) at or above which a
 * top package-export hit may receive an inlined call contract. Below
 * this (or missing top2 treated as clear) still requires a score floor.
 */
export const exportCallContractMinScoreGap = 0.15
/** Minimum top-1 hybrid final score to inline an export call contract. */
export const exportCallContractMinTopScore = 0.45
/**
 * When Jev applied, meanConfidence at or above this may inline the top
 * export call contract (also requires the top hit to be an export).
 */
export const exportCallContractMinJevMeanConfidence = 0.7
export const maxRelatedCapabilityOperations = 20
export const maxBatchEntityRefs = 10
export const maxFusedPackageCandidates = 100 /**
 * Max first-class package-export candidates promoted per package into the
 * ranked pool (widen-then-narrow). Nested `actionMatches` on package index
 * hits stay capped separately. Close runners-up within
 * `packageExportCloseScoreGap` of the top eligible export may also promote
 * (up to this cap) so Jev can choose among near-tied siblings.
 */
export const maxPackageExportCandidatesPerPackage = 3
/**
 * Promote additional export siblings when their action-match score is within
 * this gap of the top eligible export for the same package. Wider gaps keep a
 * single winner so clear export-first queries stay narrow.
 */
export const packageExportCloseScoreGap = 0.15
/**
 * Lexical action-match score at or above which a package export may enter the
 * first-pass candidate pool even with a single matched term. Nested
 * actionMatches use a lower floor (0.35); promotion is stricter to avoid
 * flooding non-export queries.
 */
export const packageExportCandidateMinScore = 0.45
/**
 * Bound wait for the ranked-search `## Waiting` block. It is a nudge, not the
 * answer, so a slow probe fan-out skips the block instead of delaying results.
 */
export const SEARCH_WAITING_ITEMS_BUDGET_MS = 1_500
export const SEARCH_APP_STARTERS_BUDGET_MS = 1_500
/**
 * Bound wait for the post-list onboarding courtesy notice. It is a nudge, not
 * the answer, so a slow checklist probe skips the notice instead of delaying
 * results (and tipping dense-account searches over SEARCH_DEADLINE_MS).
 */
export const SEARCH_ONBOARDING_NOTICE_BUDGET_MS = 1_500
/**
 * Hard ceiling for one `search` call. MCP hosts commonly time out at ~30s
 * (error -32001); failing first with a clear message beats a silent hang
 * that invites retries while the abandoned search keeps running.
 */
export const SEARCH_DEADLINE_MS = 20_000
export const SEARCH_MEMORY_ENRICHMENT_BUDGET_MS = 1_000
/** Bound wait for post-retrieval D1 acknowledgement; does not cover retrieval. */
export const SEARCH_MEMORY_ACKNOWLEDGEMENT_BUDGET_MS = 250
export const memoryEnrichmentSkippedWarning =
	'Memory enrichment was skipped; returning core results without memory context.'
export const memoryAcknowledgementWarning =
	'Memory acknowledgement did not complete; surfaced memories may repeat in this conversation.'

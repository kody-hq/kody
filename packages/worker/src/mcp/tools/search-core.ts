import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	deterministicEmbedding,
	embedTextForVectorize,
	isCapabilitySearchOffline,
	type EmbedTextFn,
} from '#worker/vectorize/embedding.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

import {
	buildRecommendedNextStep,
	buildSearchableEntityDescriptors,
} from './search-descriptors.ts'
import {
	buildDomainIndexMatches,
	buildDomainOverviewMatches,
} from './search-domain-overview.ts'
import { searchEntityPlugins } from './search-entity-registry.ts'
import { toCapabilitySearchMatch } from './search-entity-plugins/capability.ts'
import { hydrateTopPackageMatches } from './search-entity-plugins/package.ts'
import { type SearchMatch } from './search-format.ts'
import { attachHighConfidenceExportCallContract } from './search-export-call-contract.ts'
import { attachTopCapabilityCallShapes } from './search-related-capabilities.ts'
import {
	buildCandidateBaseScore,
	buildCandidateTelemetry,
	rerankCandidates,
} from './search-scoring.ts'
import { collapseSynthesizedProviderMatches } from './search-provider-overview.ts'
import { elapsedMs } from './search-timing.ts'
import {
	type OptionalSearchRowsResult,
	type PackageSearchRow,
	type SearchCandidate,
	type SearchPhaseTimings,
	type SearchUnifiedResult,
} from './search-types.ts'
import {
	rerankSearchCandidatesWithJev,
	resolveJevSearchRecallLimit,
} from './search-jev-rerank.ts'
import { understandSearchQuery } from './understand-search-query.ts'

export function buildExactPackageSearchResult(input: {
	env: Env
	query: string
	match: Extract<SearchMatch, { type: 'package' }> | null
}): SearchUnifiedResult {
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query: input.query,
		entities: [],
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const matches = input.match ? [input.match] : []
	const candidates: Array<SearchCandidate> = input.match
		? [
				{
					match: input.match,
					type: 'package',
					id: input.match.kodyId,
					title: input.match.title,
					searchFields: [input.match.kodyId, input.match.name],
					scoreComponents: buildCandidateBaseScore({
						lexical: 1,
						vector: 1,
					}),
				},
			]
		: []
	const guidance = buildRecommendedNextStep({
		query: input.query,
		intent,
		matches,
	})
	return {
		matches,
		offline: isCapabilitySearchOffline(input.env),
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates,
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs: 0,
			rerankingMs: 0,
		},
		...(guidance ? { guidance } : {}),
	}
}

function listSearchDomainNames(
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
): Array<string> {
	const names = new Set<string>(
		(registry.capabilityDomains ?? []).map((domain) => domain.name),
	)
	for (const spec of Object.values(registry.capabilitySpecs)) {
		names.add(spec.domain)
	}
	return [...names]
}

function scopeRegistryToDomain(
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
	domain: string,
): Awaited<ReturnType<typeof getCapabilityRegistryForContext>> {
	return {
		...registry,
		capabilitySpecs: Object.fromEntries(
			Object.entries(registry.capabilitySpecs).filter(
				([, spec]) => spec.domain === domain,
			),
		),
	}
}

/** Lists a whole domain's capabilities (in curated registry order) when `domain` is passed without a `query`. */
function buildDomainBrowseResult(input: {
	env: Env
	domain: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	limit: number
}): SearchUnifiedResult {
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({ query: '', entities: [] })
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const domainSpecs = Object.values(input.registry.capabilitySpecs)
	const matches = domainSpecs
		.slice(0, Math.max(1, input.limit))
		.map(toCapabilitySearchMatch)
	attachTopCapabilityCallShapes({
		matches,
		registry: input.registry,
	})
	// Large synthesized domains (mcp:*) can exceed the listing
	// limit; never let a partial listing pass silently as the whole domain.
	const guidance =
		matches.length < domainSpecs.length
			? `Domain listing truncated: showing the first ${String(matches.length)} of ${String(domainSpecs.length)} capabilities in ${JSON.stringify(input.domain)}. Raise "limit" or call metaListCapabilities({ domain: ${JSON.stringify(input.domain)} }) from execute for the complete list.`
			: buildRecommendedNextStep({
					query: '',
					intent,
					matches,
				})
	return {
		matches,
		offline: isCapabilitySearchOffline(input.env),
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates: [],
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs: 0,
			rerankingMs: 0,
		},
		...(guidance ? { guidance } : {}),
	}
}

export async function searchUnified(input: {
	env: Env
	query: string
	limit: number
	/** Authenticated user; required for fail-closed package Vectorize isolation. */
	userId?: OwnerId
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userIntegrationRows'
	>
	/** Optional capability domain id; scopes ranked results to that domain's capabilities. */
	domain?: string
	embedText?: EmbedTextFn
	/** Include admin-only official guides in ranking. */
	includeAdminGuides?: boolean
	/**
	 * Paid plan (standard/pro/max): widen hybrid recall and run stage-2 Jev
	 * when necessity allows. Free / anonymous must pass false.
	 */
	jevRerankPlanEligible?: boolean
	/** Search deadline; stops before Jev and aborts in-flight Score calls. */
	signal?: AbortSignal
}): Promise<SearchUnifiedResult> {
	const offline = isCapabilitySearchOffline(input.env)
	const query = input.query.trim()
	const domainFilter = input.domain?.trim() || undefined
	if (domainFilter) {
		const availableDomains = listSearchDomainNames(input.registry)
		if (!availableDomains.includes(domainFilter)) {
			// Caller passed a non-domain id (often a package name leaf such as
			// "skills"). Clear from the message alone — keep it off Sentry.
			throw new McpCallerError(
				`Unknown domain "${domainFilter}". Available domains: ${[...availableDomains].sort().join(', ')}.`,
			)
		}
	}
	const registry = domainFilter
		? scopeRegistryToDomain(input.registry, domainFilter)
		: input.registry
	// Domain scoping is a capability-graph drill-down; user-owned entities
	// (packages, integrations, secrets) have no domain.
	// Official guides belong to the coding domain and stay in that scope.
	const optionalRows = domainFilter
		? {
				packageRows: [],
				userSecretRows: [],
				userIntegrationRows: [],
			}
		: input.optionalRows
	if (!query) {
		if (domainFilter) {
			return buildDomainBrowseResult({
				env: input.env,
				domain: domainFilter,
				registry,
				limit: input.limit,
			})
		}
		const queryUnderstandingStart = performance.now()
		const emptyIntent = understandSearchQuery({
			query,
			entities: [],
		})
		const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
		const matches = buildDomainIndexMatches({
			capabilityDomains: input.registry.capabilityDomains ?? [],
			capabilitySpecs: input.registry.capabilitySpecs,
		})
		return {
			matches,
			offline,
			intent: emptyIntent,
			telemetry: buildCandidateTelemetry({
				intent: emptyIntent,
				candidates: [],
				matches,
			}),
			phaseTimings: {
				queryUnderstandingMs,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}

	const limit = Math.max(1, input.limit)
	const jevRerankPlanEligible = input.jevRerankPlanEligible === true
	const recallLimit = resolveJevSearchRecallLimit({
		limit,
		widerRecall: jevRerankPlanEligible,
	})
	const entityDescriptors = buildSearchableEntityDescriptors({
		registry,
		optionalRows,
		...(domainFilter ? { domain: domainFilter } : {}),
		...(input.includeAdminGuides ? { includeAdminGuides: true } : {}),
	})
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query,
		entities: entityDescriptors,
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	if (!domainFilter) {
		// Broad/exploratory queries return compact domain summaries instead of
		// ranked hits. Deliberately not sliced to `limit`: the overview is the
		// map of the capability graph, and each row is one short line
		// (`maxResponseSize` still trims oversized responses).
		const overviewMatches = buildDomainOverviewMatches({
			intent,
			capabilityDomains: input.registry.capabilityDomains ?? [],
			capabilitySpecs: input.registry.capabilitySpecs,
		})
		if (overviewMatches) {
			const overviewGuidance = buildRecommendedNextStep({
				query,
				intent,
				matches: overviewMatches,
			})
			return {
				matches: overviewMatches,
				offline,
				intent,
				telemetry: buildCandidateTelemetry({
					intent,
					candidates: [],
					matches: overviewMatches,
				}),
				phaseTimings: {
					queryUnderstandingMs,
					candidateGenerationMs: 0,
					rerankingMs: 0,
				},
				...(overviewGuidance ? { guidance: overviewGuidance } : {}),
			}
		}
	}
	const candidateGenerationStart = performance.now()
	const queryEmbeddingPromise = (async () => {
		const queryEmbeddingStart = performance.now()
		const queryEmbedding = deterministicEmbedding(intent.normalizedQuery)
		const sharedQueryVector = offline
			? queryEmbedding
			: await (
					input.embedText ?? ((text) => embedTextForVectorize(input.env, text))
				)(intent.normalizedQuery)
		return {
			queryEmbedding,
			sharedQueryVector,
			queryEmbeddingMs: elapsedMs(queryEmbeddingStart),
		}
	})()

	const candidateResults = await Promise.all(
		searchEntityPlugins.map(async (plugin) => {
			const embedding = await queryEmbeddingPromise
			const startedAt = performance.now()
			const candidates =
				'buildCandidates' in plugin && plugin.buildCandidates
					? await plugin.buildCandidates({
							env: input.env,
							query: intent.normalizedQuery,
							limit: recallLimit,
							pageLimit: limit,
							offline,
							...(input.userId ? { userId: input.userId } : {}),
							registry,
							optionalRows,
							queryEmbedding: embedding.queryEmbedding,
							sharedQueryVector: embedding.sharedQueryVector,
							...(domainFilter ? { domain: domainFilter } : {}),
							...(input.includeAdminGuides ? { includeAdminGuides: true } : {}),
						})
					: []
			return {
				plugin,
				candidates,
				durationMs: elapsedMs(startedAt),
			}
		}),
	)
	const queryEmbeddingMs = (await queryEmbeddingPromise).queryEmbeddingMs
	// Annotate the flatMap callback: `as const` plugins infer distinct candidate
	// array element types, and without this TS widens the union to `unknown[]`.
	const candidates = candidateResults.flatMap(
		(result): Array<SearchCandidate> => result.candidates,
	)
	const candidateTimings: Pick<
		SearchPhaseTimings,
		'capabilityCandidatesMs' | 'packageCandidatesMs'
	> = {}
	for (const result of candidateResults) {
		const candidateTimingKey =
			'candidateTimingKey' in result.plugin
				? result.plugin.candidateTimingKey
				: undefined
		if (candidateTimingKey === 'capabilityCandidatesMs') {
			candidateTimings.capabilityCandidatesMs = result.durationMs
		}
		if (candidateTimingKey === 'packageCandidatesMs') {
			candidateTimings.packageCandidatesMs = result.durationMs
		}
	}
	const candidateGenerationMs = elapsedMs(candidateGenerationStart)
	input.signal?.throwIfAborted()
	const rerankingStart = performance.now()
	const hybridReranked = rerankCandidates({
		candidates,
		intent,
		limit: recallLimit,
	})
	const jevRerank = await rerankSearchCandidatesWithJev({
		env: input.env,
		query: intent.normalizedQuery,
		intent,
		candidates: hybridReranked,
		limit,
		offline,
		planEligible: jevRerankPlanEligible,
		...(input.signal ? { signal: input.signal } : {}),
	})
	const reranked = jevRerank.candidates
	const matches = domainFilter
		? reranked.map((candidate) => candidate.match)
		: collapseSynthesizedProviderMatches({
				query,
				candidates: reranked,
				registry,
			})
	attachTopCapabilityCallShapes({
		matches,
		registry,
	})
	await hydrateTopPackageMatches({
		query: intent.normalizedQuery,
		matches,
		rows: optionalRows.packageRows,
	})
	attachHighConfidenceExportCallContract({
		matches,
		rankedCandidates: reranked,
		jevOutcome: jevRerank.outcome,
		jevMeanConfidence: jevRerank.meanConfidence,
	})
	const rerankingMs = elapsedMs(rerankingStart)

	return {
		matches,
		offline,
		intent,
		telemetry: {
			...buildCandidateTelemetry({
				intent,
				candidates,
				matches,
			}),
			jevRerank: {
				enabled: true,
				outcome: jevRerank.outcome,
				candidatesBefore: jevRerank.candidatesBefore,
				candidatesAfter: jevRerank.candidatesAfter,
				droppedCount: jevRerank.droppedCount,
				meanConfidence: jevRerank.meanConfidence,
				top1Type: jevRerank.top1Type,
				...(jevRerank.keepPath ? { keepPath: jevRerank.keepPath } : {}),
				...(jevRerank.errorReason
					? { errorReason: jevRerank.errorReason }
					: {}),
				...(jevRerank.model
					? {
							model: jevRerank.model,
							aiCallCount: jevRerank.aiCallCount ?? 0,
							usage: jevRerank.usage ?? {
								inputTokens: null,
								outputTokens: null,
							},
						}
					: {}),
			},
		},
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs,
			rerankingMs,
			queryEmbeddingMs,
			jevRerankMs: jevRerank.durationMs,
			...candidateTimings,
		},
		guidance: buildRecommendedNextStep({
			query,
			intent,
			matches,
		}),
	}
}

export async function searchPackages(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	userId?: OwnerId
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const result = await searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		userId: input.userId,
		registry: {
			capabilitySpecs: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
		optionalRows: {
			packageRows: input.rows,
			userSecretRows: [],
			userIntegrationRows: [],
		},
	})
	return {
		matches: result.matches,
		offline: result.offline,
	}
}

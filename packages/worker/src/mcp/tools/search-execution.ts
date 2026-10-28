import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { callerHasRole } from '#mcp/capabilities/access-control.ts'
import { buildMemoryRetrievalQuery } from '#mcp/tools/memory-tool-context.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	createTextEmbeddingCache,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'

import { consumeSearchRateLimit } from '#worker/search-rate-limit.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'
import { isPaidPlan, type PlanName } from '#universal/plans.ts'
import { entitlementEmailForOwner } from '#worker/request-context/owner-id.ts'

import { resolvePackageIdentitySearch } from './package-search-identity.ts'
import { buildExactPackageSearchResult, searchUnified } from './search-core.ts'
import { searchQueryUsesRankingEmbedding } from './search-domain-overview.ts'
import { loadSearchRowsAndRegistry } from './search-loaders.ts'
import {
	launchSearchMemoryEnrichment,
	settleSearchMemoryEnrichment,
} from './search-memory.ts'
import { elapsedMs } from './search-timing.ts'
import {
	type SearchMemoryEnrichmentSettlement,
	type SearchPhaseTimings,
	type SearchUnifiedResult,
} from './search-types.ts'
import { type SearchToolArgs } from './search-tool-definition.ts'
import { queryMatchesSynthesizedProvider } from './search-provider-overview.ts'
import { normalizeSearchText } from './understand-search-query.ts'

export type SearchListExecutionResult = {
	result: SearchUnifiedResult
	username: string | null
	warnings: Array<string>
	memorySettlement: SearchMemoryEnrichmentSettlement
	phaseTimings: Partial<SearchPhaseTimings>
	capabilityGuidance?: string
}

type ExecuteSearchListInput = {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	query: string
	memoryQuery?: string
	limit: number
	userId: OwnerId | null
	includeHiddenPackages: boolean
	memoryContext?: SearchToolArgs['memoryContext']
	/** Optional capability domain id; scopes ranked results to that domain's capabilities. */
	domain?: string
	/**
	 * Filled as each phase finishes, so a caller that abandons the search at
	 * its deadline can still report which phases completed.
	 */
	phaseTimings?: Partial<SearchPhaseTimings>
	/** Aborted when the caller's search deadline passes; later phases stop. */
	signal?: AbortSignal
}

export async function executeSearchList(
	input: ExecuteSearchListInput,
): Promise<SearchListExecutionResult> {
	const phaseTimings: Partial<SearchPhaseTimings> = input.phaseTimings ?? {}
	// Team-bound search keys discovery to request.org.id; pair that OwnerId with
	// a blank email so plan / rate-limit reverse-resolve the org (member email
	// against a team id always misses and falls through to public free).
	const entitlementEmail = input.userId
		? entitlementEmailForOwner(input.callerContext, input.userId)
		: null
	// Jev eligibility reads the plan fresh, alongside the rate-limit writes;
	// only the abuse ceilings use the cached plan. A failed read keeps hybrid
	// order, like any other Jev failure, instead of failing the search.
	const jevPlanPromise: Promise<PlanName> =
		input.userId && input.env.APP_DB
			? getUserPlan(input.env.APP_DB, {
					userId: input.userId,
					email: entitlementEmail,
				}).catch(() => 'free')
			: Promise.resolve('free')
	const rateLimitStart = performance.now()
	// Abuse ceiling only (not an entitlement): reject before embeddings / Jev.
	await consumeSearchRateLimit({
		db: input.env.APP_DB,
		userId: input.userId,
		email: entitlementEmail,
	})
	phaseTimings.rateLimitMs = elapsedMs(rateLimitStart)
	const domainFilter = input.domain?.trim() || undefined
	const usernameStart = performance.now()
	// Team-bound search must label packages with the org slug, not the actor
	// person handle (otherwise exact URLs and hosted app links go to /@actor/…).
	const boundOrg = input.callerContext.request?.org
	const actor = input.callerContext.user
	const boundToTeamOrg =
		Boolean(boundOrg?.slug?.trim()) &&
		Boolean(actor) &&
		boundOrg!.id !== personalOrgIdForPerson(actor!)
	const username = boundToTeamOrg
		? boundOrg!.slug!.trim()
		: await resolvePublicUsername({
				db: input.env.APP_DB,
				username: input.callerContext.user?.username ?? null,
				email: input.callerContext.user?.email ?? null,
			})
	phaseTimings.usernameLookupMs = elapsedMs(usernameStart)
	// Domain-scoped searches rank capabilities only; exact package identity
	// resolution does not apply.
	const identityStart = performance.now()
	const identityResolution =
		input.query && !domainFilter
			? await resolvePackageIdentitySearch({
					db: input.env.APP_DB,
					env: input.env,
					userId: input.userId,
					query: input.query,
					baseUrl: input.callerContext.baseUrl,
					packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
					packageAppLegacyHosts: input.env.PACKAGE_APP_LEGACY_HOSTS,
					username,
					includeHiddenPackages: input.includeHiddenPackages,
				})
			: { recognized: false as const }
	let preloadedSearchRows: Awaited<
		ReturnType<typeof loadSearchRowsAndRegistry>
	> | null = null
	let identityMatchesProvider = false
	if (
		identityResolution.recognized &&
		identityResolution.match &&
		input.query.trim().toLowerCase() ===
			identityResolution.match.kodyId.toLowerCase()
	) {
		preloadedSearchRows = await loadSearchRowsAndRegistry({
			env: input.env,
			callerContext: input.callerContext,
			userId: input.userId,
			includeHiddenPackages: input.includeHiddenPackages,
		})
		identityMatchesProvider = queryMatchesSynthesizedProvider({
			query: input.query,
			registry: preloadedSearchRows.registry,
		})
	}
	// Includes the exact-identity registry preload so it is not unaccounted.
	phaseTimings.identityResolutionMs = elapsedMs(identityStart)
	const memoryContextRetrievalQuery = buildMemoryRetrievalQuery(
		input.memoryContext,
	)
	const shouldEnrichMemory =
		(Boolean(input.query) || Boolean(memoryContextRetrievalQuery)) &&
		(!identityResolution.recognized || identityMatchesProvider)
	const willRankSearch = !(
		identityResolution.recognized && !identityMatchesProvider
	)
	const embeddingCache = createTextEmbeddingCache(input.env)
	const normalizedQuery = normalizeSearchText(input.query).trim()
	const loadAndRankStart = willRankSearch ? performance.now() : null
	if (
		willRankSearch &&
		searchQueryUsesRankingEmbedding({
			query: input.query,
			domain: domainFilter,
		}) &&
		normalizedQuery &&
		!isCapabilitySearchOffline(input.env)
	) {
		void embeddingCache.embedText(normalizedQuery).catch(() => {})
	}
	const memoryLaunch = shouldEnrichMemory
		? launchSearchMemoryEnrichment({
				env: input.env,
				callerContext: input.callerContext,
				conversationId: input.conversationId,
				query: input.memoryQuery,
				memoryContext: input.memoryContext,
				embedText: embeddingCache.embedText,
			})
		: null
	const memoryEnrichmentPromise = memoryLaunch?.promise ?? Promise.resolve(null)
	const memoryEnrichmentLaunchedAtMs = memoryLaunch?.launchedAtMs
	let warnings: Array<string> = []
	let result: SearchUnifiedResult
	let capabilityGuidance: string | undefined

	if (identityResolution.recognized && !identityMatchesProvider) {
		result = buildExactPackageSearchResult({
			env: input.env,
			query: input.query,
			match: identityResolution.match,
		})
		const memorySettlement: SearchMemoryEnrichmentSettlement = {
			warnings: [],
			phaseTimings: {},
		}
		warnings.push(...(preloadedSearchRows?.warnings ?? []))
		return {
			result,
			username,
			warnings,
			memorySettlement,
			phaseTimings,
		}
	}

	const rowAndRegistryLoadStart = performance.now()
	const rowsPromise = (
		preloadedSearchRows
			? Promise.resolve(preloadedSearchRows)
			: loadSearchRowsAndRegistry({
					env: input.env,
					callerContext: input.callerContext,
					userId: input.userId,
					includeHiddenPackages: input.includeHiddenPackages,
				})
	).then((rows) => {
		phaseTimings.rowAndRegistryLoadMs = elapsedMs(rowAndRegistryLoadStart)
		return rows
	})
	const [searchRows, jevPlan] = await Promise.all([rowsPromise, jevPlanPromise])
	input.signal?.throwIfAborted()
	warnings = searchRows.warnings
	const jevRerankPlanEligible = isPaidPlan(jevPlan)
	const searchUnifiedStart = performance.now()
	const rankedPromise = searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		userId: input.userId ?? undefined,
		registry: searchRows.registry,
		optionalRows: searchRows,
		embedText: embeddingCache.embedText,
		...(domainFilter ? { domain: domainFilter } : {}),
		...(callerHasRole(input.callerContext, 'admin')
			? { includeAdminGuides: true }
			: {}),
		...(jevRerankPlanEligible ? { jevRerankPlanEligible: true } : {}),
		...(input.signal ? { signal: input.signal } : {}),
	})
	result = await rankedPromise
	input.signal?.throwIfAborted()
	phaseTimings.searchUnifiedMs = elapsedMs(searchUnifiedStart)
	capabilityGuidance = result.guidance
	const returnsDomainIndex =
		result.matches.length > 0 &&
		result.matches.every((match) => match.type === 'domain')
	const memorySettlement =
		shouldEnrichMemory &&
		(!returnsDomainIndex || Boolean(memoryContextRetrievalQuery))
			? await settleSearchMemoryEnrichment({
					promise: memoryEnrichmentPromise,
					launchedAtMs: memoryEnrichmentLaunchedAtMs,
				})
			: ({
					warnings: [],
					phaseTimings: {},
				} satisfies SearchMemoryEnrichmentSettlement)
	Object.assign(phaseTimings, memorySettlement.phaseTimings)
	warnings.push(...memorySettlement.warnings)
	if (loadAndRankStart != null) {
		phaseTimings.loadAndRankMs = elapsedMs(loadAndRankStart)
	}

	return {
		result,
		username,
		warnings,
		memorySettlement,
		phaseTimings,
		...(capabilityGuidance ? { capabilityGuidance } : {}),
	}
}

import type {
	CapabilityDomainMetadata,
	CapabilitySpec,
} from '#mcp/capabilities/types.ts'

import type { SearchMatch } from './search-format-types.ts'
import { buildDomainIndexMatches } from './search-domain-index.ts'
import {
	type SearchIntent,
	extractSearchTokens,
	understandSearchQuery,
} from './understand-search-query.ts'

/**
 * Generic discovery/browse words. A query qualifies for a domain overview only
 * when every meaningful token is either one of these or a domain-name token, so
 * task-specific queries ("send an email") keep returning ranked capabilities.
 */
const explorationQueryTokens = new Set([
	'able',
	'action',
	'actions',
	'all',
	'anything',
	'are',
	'available',
	'be',
	'browse',
	'can',
	'capabilities',
	'capability',
	'categories',
	'category',
	'could',
	'do',
	'does',
	'domain',
	'domains',
	'everything',
	'exist',
	'exists',
	'explore',
	'feature',
	'features',
	'functionality',
	'functions',
	'group',
	'groups',
	'has',
	'have',
	'help',
	'here',
	'kind',
	'kinds',
	'kody',
	'offer',
	'offers',
	'option',
	'options',
	'overview',
	'possible',
	'stuff',
	'support',
	'supported',
	'supports',
	'there',
	'thing',
	'things',
	'tool',
	'tooling',
	'tools',
	'type',
	'types',
	'what',
	'which',
	'you',
	'your',
])

/** Fold trivial plurals so "jobs" matches the `jobs` domain and vice versa. */
function singularizeToken(token: string): string {
	if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss')) {
		return token.slice(0, -1)
	}
	return token
}

export function searchQueryUsesRankingEmbedding(input: {
	query: string
	domain?: string
}): boolean {
	const query = input.query.trim()
	if (!query) return false
	if (input.domain?.trim()) return true
	const intent = understandSearchQuery({ query, entities: [] })
	if (intent.meaningfulTokens.length === 0) return true
	return intent.meaningfulTokens.some(
		(token) => !explorationQueryTokens.has(token),
	)
}

/**
 * Broad/exploratory queries ("what can you do with email", "what can kody
 * do") return compact domain summaries instead of ranked individual hits, so
 * agents spend tokens on a map of the capability graph rather than an
 * arbitrary slice of it. Returns null for task-specific queries, which keep
 * the full ranked pipeline.
 */
export function buildDomainOverviewMatches(input: {
	intent: SearchIntent
	capabilityDomains: ReadonlyArray<CapabilityDomainMetadata>
	capabilitySpecs: Record<string, CapabilitySpec>
}): Array<SearchMatch> | null {
	const meaningfulTokens = input.intent.meaningfulTokens
	if (meaningfulTokens.length === 0) return null
	if (input.capabilityDomains.length === 0) return null

	const domainIndex = buildDomainIndexMatches(input)
	const specsByDomain = new Map<string, Array<CapabilitySpec>>()
	for (const spec of Object.values(input.capabilitySpecs)) {
		const group = specsByDomain.get(spec.domain) ?? []
		group.push(spec)
		specsByDomain.set(spec.domain, group)
	}
	const visibleDomains = input.capabilityDomains.filter((domain) =>
		domainIndex.some(
			(match) => match.type === 'domain' && match.name === domain.name,
		),
	)
	if (visibleDomains.length === 0) return null

	const queryConceptsByToken = new Map(
		meaningfulTokens.map((token) => [token, singularizeToken(token)] as const),
	)
	const matchedDomains: Array<CapabilityDomainMetadata> = []
	const domainMatchedTokens = new Set<string>()
	for (const domain of visibleDomains) {
		const synthesizedDomain = domain.name.includes(':')
		if (
			synthesizedDomain &&
			input.intent.normalizedQuery !==
				extractSearchTokens(domain.name).join(' ')
		) {
			continue
		}
		const nameConcepts = new Set(
			extractSearchTokens(domain.name).map(singularizeToken),
		)
		let matched = false
		for (const [token, concept] of queryConceptsByToken) {
			if (!nameConcepts.has(concept)) continue
			matched = true
			domainMatchedTokens.add(token)
		}
		if (matched) matchedDomains.push(domain)
	}

	const residualTokens = meaningfulTokens.filter(
		(token) =>
			!domainMatchedTokens.has(token) && !explorationQueryTokens.has(token),
	)
	if (residualTokens.length > 0) return null

	const overviewDomains =
		matchedDomains.length > 0 ? matchedDomains : visibleDomains
	if (matchedDomains.length === 0) {
		// Pure exploration query ("what can kody do") with no domain named:
		// require at least one exploration token so token-free noise never
		// produces an overview.
		const hasExplorationToken = meaningfulTokens.some((token) =>
			explorationQueryTokens.has(token),
		)
		if (!hasExplorationToken) return null
	}

	return buildDomainIndexMatches({
		capabilityDomains: overviewDomains,
		capabilitySpecs: input.capabilitySpecs,
	})
}

export { buildDomainIndexMatches }

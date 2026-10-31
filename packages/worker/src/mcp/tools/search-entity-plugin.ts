import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

import {
	type SearchEntityDetail,
	type SearchEntityDetailStructured,
	type SearchMatch,
	type SlimSearchMatch,
} from './search-format-types.ts'
import {
	type OptionalSearchRowsResult,
	type SearchCandidate,
	type SearchPhaseTimings,
} from './search-types.ts'
import { type SearchableEntityDescriptor } from './understand-search-query.ts'

export type SearchEntityCandidateInput = {
	env: Env
	query: string
	/** Recall width; Jev-eligible searches widen this past the page size. */
	limit: number
	/**
	 * Caller's requested result count. Per-candidate enrichment (package
	 * hydration) scales with this, not with widened recall.
	 */
	pageLimit?: number
	offline: boolean
	userId?: OwnerId
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userIntegrationRows'
	>
	queryEmbedding: ReadonlyArray<number>
	sharedQueryVector?: ReadonlyArray<number>
	/** Capability domain id when ranked search is scoped to one domain. */
	domain?: string
	/** Include admin-only official guides in ranking. */
	includeAdminGuides?: boolean
}

export type SearchEntityDescriptorInput = {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userIntegrationRows'
	>
	/** Capability domain id when ranked search is scoped to one domain. */
	domain?: string
	/** Include admin-only official guides in ranking. */
	includeAdminGuides?: boolean
}

export type SearchEntitySlimFormatInput<
	Match extends SearchMatch = SearchMatch,
> = {
	match: Match
	baseUrl: string
	/** Origin for hosted package apps when separate from the app origin. */
	packageAppBaseUrl?: string | null
	username?: string | null
}

export type SearchEntityDetailFormatResult = {
	markdown: string
	structured: SearchEntityDetailStructured
}

export type SearchEntityPlugin<Type extends SearchMatch['type']> = {
	type: Type
	candidateTimingKey?: keyof Pick<
		SearchPhaseTimings,
		'capabilityCandidatesMs' | 'packageCandidatesMs'
	>
	buildDescriptors?: (
		input: SearchEntityDescriptorInput,
	) => Array<SearchableEntityDescriptor>
	buildCandidates?: (
		input: SearchEntityCandidateInput,
	) => Array<SearchCandidate> | Promise<Array<SearchCandidate>>
	formatSlimMatch?: (
		input: SearchEntitySlimFormatInput<Extract<SearchMatch, { type: Type }>>,
	) => SlimSearchMatch
	formatEntityDetail?: (
		detail: Extract<SearchEntityDetail, { type: Type }>,
		options?: { includeBoilerplate?: boolean },
	) => SearchEntityDetailFormatResult
}

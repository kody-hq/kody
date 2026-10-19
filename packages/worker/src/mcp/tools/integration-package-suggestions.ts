import { buildCommunityPublicUrl } from '#mcp/capabilities/community/shared.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { searchCommunityListings } from '#worker/community/service.ts'
import {
	resolveIntegrationProviderName,
	type IntegrationProviderMetadata,
} from '#worker/integrations/provider-name.ts'
import { type RelatedIntegrationPackageSuggestion } from './search-format.ts'
import { extractSearchTokens } from './understand-search-query.ts'

export { resolveIntegrationProviderName }

export const maxIntegrationPackageSuggestions = 3
const communitySuggestionCandidateLimit = 12

type ProviderPackageIdentity = {
	kodyId: string
	name: string
	tags: ReadonlyArray<string>
}

type SuggestionPackageRow = {
	record: {
		kodyId: string
		name: string
		description: string
		tags: Array<string>
	}
}

export function packageIdentityMentionsProvider(
	identity: ProviderPackageIdentity,
	providerName: string,
): boolean {
	const provider = canonicalIntegrationName(providerName)
	const providerTokens = extractSearchTokens(provider)
	if (providerTokens.length === 0) return false

	const identityTokens = new Set(
		extractSearchTokens(
			[identity.kodyId, identity.name, identity.tags.join(' ')].join('\n'),
		),
	)
	return providerTokens.every((token) => identityTokens.has(token))
}

function toUserSuggestion(
	row: SuggestionPackageRow,
): RelatedIntegrationPackageSuggestion {
	return {
		source: 'user',
		kodyId: row.record.kodyId,
		name: row.record.name,
		description: row.record.description,
		entityRef: `package:${row.record.kodyId}`,
	}
}

function toCommunitySuggestion(input: {
	listing: Awaited<ReturnType<typeof searchCommunityListings>>[number]
	baseUrl: string
}): RelatedIntegrationPackageSuggestion {
	return {
		source: 'community',
		kodyId: input.listing.kodyId,
		name: input.listing.name,
		description: input.listing.description,
		listingId: input.listing.id,
		publicUrl: buildCommunityPublicUrl(input.baseUrl, {
			listingId: input.listing.id,
			name: input.listing.name,
			kodyId: input.listing.kodyId,
		}),
		trusted: input.listing.trusted,
	}
}

function collectSameProviderUserSuggestions(
	packageRows: ReadonlyArray<SuggestionPackageRow>,
	providerName: string,
): Array<RelatedIntegrationPackageSuggestion> {
	const suggestions: Array<RelatedIntegrationPackageSuggestion> = []
	for (const row of packageRows) {
		if (
			!packageIdentityMentionsProvider(
				{
					kodyId: row.record.kodyId,
					name: row.record.name,
					tags: row.record.tags,
				},
				providerName,
			)
		) {
			continue
		}
		suggestions.push(toUserSuggestion(row))
		if (suggestions.length >= maxIntegrationPackageSuggestions) break
	}
	return suggestions
}

async function collectSameProviderCommunitySuggestions(input: {
	env: Env
	baseUrl: string
	providerName: string
}): Promise<Array<RelatedIntegrationPackageSuggestion>> {
	const provider = canonicalIntegrationName(input.providerName)
	let listings: Awaited<ReturnType<typeof searchCommunityListings>>
	try {
		listings = await searchCommunityListings({
			env: input.env,
			query: provider,
			limit: communitySuggestionCandidateLimit,
			resultFilter: (listing) =>
				packageIdentityMentionsProvider(
					{
						kodyId: listing.kodyId,
						name: listing.name,
						tags: listing.tags,
					},
					provider,
				),
		})
	} catch {
		return []
	}

	const sameProvider = listings.filter((listing) =>
		packageIdentityMentionsProvider(
			{
				kodyId: listing.kodyId,
				name: listing.name,
				tags: listing.tags,
			},
			provider,
		),
	)
	const ordered = sameProvider.slice(0, maxIntegrationPackageSuggestions)
	return ordered.map((listing) =>
		toCommunitySuggestion({ listing, baseUrl: input.baseUrl }),
	)
}

/**
 * Detail-only helper: suggest same-provider packages for an integration.
 * Prefers the user's own packages and skips community lookup when any exist.
 * Community suggestions are popularity-ranked and capped.
 */
export async function collectIntegrationPackageSuggestions(input: {
	env: Env
	baseUrl: string
	integration: IntegrationProviderMetadata
	packageRows: ReadonlyArray<SuggestionPackageRow>
}): Promise<Array<RelatedIntegrationPackageSuggestion>> {
	const providerName = resolveIntegrationProviderName(input.integration)
	const userSuggestions = collectSameProviderUserSuggestions(
		input.packageRows,
		providerName,
	)
	if (userSuggestions.length > 0) {
		return userSuggestions
	}
	return await collectSameProviderCommunitySuggestions({
		env: input.env,
		baseUrl: input.baseUrl,
		providerName,
	})
}

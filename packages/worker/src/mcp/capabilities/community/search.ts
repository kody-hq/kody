import { z } from 'zod'
import { communityListingCategories } from '#universal/community-categories.ts'
import {
	communityListingSorts,
	defaultCommunityListingSort,
} from '#universal/community-search.ts'
import { searchCommunityListings } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildCommunityPublicUrl,
	communitySearchGuidance,
	communitySearchMatchSchema,
	toCommunityListingAggregatesOutput,
} from './shared.ts'

const communitySearchNoMatchGuidance =
	'No public packages met the relevance floor for this query. Rephrase with the provider, data source, or concrete workflow you need; if nothing close exists, create a new package instead of adapting an unrelated result.'

export const communitySearchCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communitySearch',
		contextRuns: 'allow',
		orgPermission: 'search:read',
		description:
			'Search public package listings on this deployment. Default ranking is relevance and community ratings; pass sort=newest for last published first. Pass category to browse one closed listing category. Use `communityGet` for full detail before forking.',
		keywords: [
			'community',
			'search',
			'listing',
			'marketplace',
			'package',
			'fork',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.describe('Natural-language search query for public packages.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.default(10)
				.describe('Maximum number of matches to return (default 10, max 50).'),
			sort: z
				.enum(communityListingSorts)
				.optional()
				.default(defaultCommunityListingSort)
				.describe(
					'best (default) ranks by relevance and ratings. newest orders matching listings by last community publish, including republishes.',
				),
			category: z
				.enum(communityListingCategories)
				.optional()
				.describe(
					'Optional browse category. integrations, examples, productivity, apps, and utilities come from package.json#kody.category (or tag inference). other is the uncategorized remainder.',
				),
		}),
		outputSchema: z.object({
			outcome: z.enum(['matches', 'no_matches']),
			guidance: z.string(),
			matches: z.array(communitySearchMatchSchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const listings = await searchCommunityListings({
				env: ctx.env,
				query: args.query,
				limit: args.limit ?? 10,
				sort: args.sort ?? defaultCommunityListingSort,
				category: args.category,
			})
			const noMatches = Boolean(args.query.trim()) && listings.length === 0
			return {
				outcome: noMatches ? ('no_matches' as const) : ('matches' as const),
				guidance: noMatches
					? `${communitySearchNoMatchGuidance} ${communitySearchGuidance}`
					: communitySearchGuidance,
				matches: listings.map((listing) => ({
					listing_id: listing.id,
					name: listing.name,
					kody_id: listing.kodyId,
					description: listing.description,
					tags: listing.tags,
					category: listing.category,
					version: listing.version ?? null,
					owner_anonymous: true as const,
					trusted: listing.trusted,
					relevance: listing.relevance,
					published_at: listing.publishedAt,
					...toCommunityListingAggregatesOutput(listing),
					public_url: buildCommunityPublicUrl(ctx.callerContext.baseUrl, {
						listingId: listing.id,
						name: listing.name,
						kodyId: listing.kodyId,
					}),
				})),
			}
		},
	},
)

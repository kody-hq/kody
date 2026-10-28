import { z } from 'zod'
import { communityListingCategories } from '#universal/community-categories.ts'
import { getCommunityListingWithAggregates } from '#worker/community/service.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { callerContextFields } from '#mcp/observability.ts'
import {
	buildCommunityOwnerProfileUrl,
	buildCommunityPublicUrl,
	communityContentWarning,
	communityFeaturedFieldSchema,
	communityGetForkInstructions,
	communityListingAggregatesSchema,
	communityListingStatusSchema,
	communityPublicUrlSchema,
	communityTrustedFieldSchema,
	resolveCommunityOwnerUsername,
	toCommunityListingAggregatesOutput,
} from './shared.ts'

export const communityGetCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityGet',
		contextRuns: 'allow',
		orgPermission: 'search:read',
		description:
			'Load full detail for one public package, including untrusted README content and aggregate ratings.',
		keywords: ['community', 'get', 'listing', 'detail', 'readme', 'package'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Catalog entry id to load.'),
		}),
		outputSchema: communityListingAggregatesSchema.extend({
			listing_id: z.string(),
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			tags: z.array(z.string()),
			category: z.enum(communityListingCategories),
			license: z.string(),
			version: z
				.string()
				.nullable()
				.describe(
					'package.json#version from the pinned listing snapshot, or null when the author did not set a string version.',
				),
			pinned_commit: z.string(),
			status: communityListingStatusSchema,
			trusted: communityTrustedFieldSchema,
			featured: communityFeaturedFieldSchema,
			owner_username: z.string(),
			owner_profile_url: z.string().nullable(),
			public_url: communityPublicUrlSchema,
			published_at: z.string(),
			readme_untrusted: z.string().nullable(),
			content_warning: z.string(),
			fork_instructions: z.string(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const { baseUrl } = callerContextFields(ctx.callerContext)
			const listing = await getCommunityListingWithAggregates({
				env: ctx.env,
				listingId: args.listing_id,
				includeDelisted: false,
			})
			if (!listing) {
				// Missing / delisted listing ids are routine agent turns, not
				// platform defects — keep them on mcp-event and out of Sentry.
				throw new McpCallerError('Catalog entry not found.')
			}
			const ownerUsername = resolveCommunityOwnerUsername(listing.name)
			const ownerRow = await getUserSocialRowByUsername(
				ctx.env.APP_DB,
				ownerUsername,
			)
			const ownerProfilePublic = ownerRow?.profile_visibility === 'public'
			return {
				listing_id: listing.id,
				name: listing.name,
				kody_id: listing.kodyId,
				description: listing.description,
				tags: listing.tags,
				category: listing.category,
				license: listing.license,
				version: listing.version ?? null,
				pinned_commit: listing.pinnedCommit,
				status: listing.status,
				trusted: listing.trusted,
				featured: listing.featured,
				owner_username: ownerUsername,
				owner_profile_url: ownerProfilePublic
					? buildCommunityOwnerProfileUrl(baseUrl, ownerUsername)
					: null,
				public_url: buildCommunityPublicUrl(baseUrl, {
					listingId: listing.id,
					name: listing.name,
					kodyId: listing.kodyId,
					ownerUsername,
				}),
				published_at: listing.publishedAt,
				...toCommunityListingAggregatesOutput(listing),
				readme_untrusted: listing.readmeContent,
				content_warning: communityContentWarning,
				fork_instructions: communityGetForkInstructions,
			}
		},
	},
)

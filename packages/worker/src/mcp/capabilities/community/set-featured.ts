import { z } from 'zod'
import { setCommunityListingFeatured } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { auditAdminCapabilityInvocation } from '#mcp/capabilities/admin/admin-shared.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { communityListingStatusSchema } from './shared.ts'

export const communitySetFeaturedCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communitySetFeatured',
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			'Admin-only curation: mark a public package as an onboarding starter package, or remove the mark. Featured is editorial placement on /onboarding, not a safety review.',
		keywords: [
			'community',
			'featured',
			'onboarding',
			'starter',
			'curate',
			'admin',
			'listing',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		requiredRole: 'admin',
		inputSchema: z.object({
			listing_id: z
				.string()
				.min(1)
				.describe('Catalog entry id to mark or unmark as featured.'),
			featured: z
				.boolean()
				.describe(
					'True to feature this listing in onboarding; false to remove it.',
				),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			name: z.string(),
			status: communityListingStatusSchema,
			featured: z.boolean(),
			featured_at: z.string().nullable(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			return await auditAdminCapabilityInvocation(
				ctx,
				'communitySetFeatured',
				async () => {
					const listing = await setCommunityListingFeatured({
						env: ctx.env,
						listingId: args.listing_id,
						featured: args.featured,
					})
					return {
						listing_id: listing.id,
						name: listing.name,
						status: listing.status,
						featured: listing.featured,
						featured_at: listing.featuredAt,
					}
				},
				{
					successReason: (result) =>
						`listing_id=${result.listing_id};featured=${result.featured}`,
				},
			)
		},
	},
)

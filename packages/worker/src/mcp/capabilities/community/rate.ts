import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { rateCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

export const communityRateCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityRate',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'Rate a public package after forking it. Stars measure usefulness (1–5); adaptation_effort measures how hard it was to adapt (1 = trivial, 5 = very hard). Ratings feed community search ranking.',
		keywords: ['community', 'rate', 'rating', 'stars', 'fork', 'review'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Catalog entry id to rate.'),
			stars: z
				.number()
				.int()
				.min(1)
				.max(5)
				.describe('Usefulness rating from 1 (low) to 5 (high).'),
			adaptation_effort: z
				.number()
				.int()
				.min(1)
				.max(5)
				.describe('Adaptation difficulty from 1 (trivial) to 5 (very hard).'),
			note: z
				.string()
				.max(1000)
				.optional()
				.describe('Optional short note about the fork experience.'),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			rated: z.literal(true),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await rateCommunityListing({
				env: ctx.env,
				// The rating is person-keyed (not personal org).
				userId: personalOrgId(user.userId),
				// communityFork keys the fork by the bound org.
				forkOwnerId: ownerIdFromCaller(ctx.callerContext),
				listingId: args.listing_id,
				stars: args.stars,
				adaptationEffort: args.adaptation_effort,
				note: args.note,
			})
			return {
				listing_id: args.listing_id,
				rated: true as const,
			}
		},
	},
)

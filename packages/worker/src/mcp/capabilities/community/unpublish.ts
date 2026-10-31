import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { unpublishCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'

export const communityUnpublishCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityUnpublish',
		contextRuns: 'deny',
		orgPermission: 'package:publish',
		description:
			'Make a public package private: unlist it from /community and 404 public URLs (existing forks keep their copies). Prefer packageUpdate with changes.visibility: "private" and confirm_name matching the package slug. Delisted listings cannot be unpublished by the owner.',
		keywords: ['community', 'unpublish', 'delist', 'remove', 'listing'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Catalog entry id to unpublish.'),
			confirm_name: z
				.string()
				.min(1)
				.describe(
					'Must equal the package name leaf (URL slug). Confirm with the user first: going private 404s public URLs and unlists the catalog; existing forks keep their copies.',
				),
		}),
		outputSchema: z.object({
			listing_id: z.string(),
			unpublished: z.literal(true),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const listing = await getCommunityListingById(ctx.env.APP_DB, {
				listingId: args.listing_id,
				includeDelisted: true,
			})
			if (!listing || listing.ownerUserId !== owner.ownerUserId) {
				throw new McpCallerError(
					`Catalog entry "${args.listing_id}" was not found.`,
				)
			}
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{
					id: listing.packageId,
					userId: listing.ownerUserId,
					label: listing.name,
				},
				'package:publish',
			)
			if (args.confirm_name.trim() !== listing.kodyId) {
				throw new McpCallerError(
					`Making this package private unlists it from /community and 404s public URLs. Existing forks keep their copies. Confirm with the user, then pass confirm_name: "${listing.kodyId}" (the package slug).`,
				)
			}
			await unpublishCommunityListing({
				env: ctx.env,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				listingId: args.listing_id,
			})
			return {
				listing_id: args.listing_id,
				unpublished: true as const,
			}
		},
	},
)

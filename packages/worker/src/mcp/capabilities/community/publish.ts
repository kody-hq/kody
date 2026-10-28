import { z } from 'zod'
import { publishCommunityListing } from '#worker/community/service.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	communityListingSummarySchema,
	toCommunityListingSummaryOutput,
} from './shared.ts'

export const communityPublishCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityPublish',
		contextRuns: 'deny',
		orgPermission: 'package:publish',
		description:
			'Make a saved package public (first community listing), or force-refresh an already-public listing to the current published_commit. Default-branch HEAD becomes world-readable and forkable, and the package appears on /community. Prefer packageUpdate with changes.visibility: "public" for the first publish. After that, packagePublishExternalPush / promote auto-advance the listing pin — you do not need a separate republish step. Before calling for a first publish, review the package for overly personal content (package_authoring visibility). If anything looks personal, stop, tell the user, suggest generalizing, and wait for explicit go-ahead. No license, logo, or Intent platform gates. Runtime uses published_commit. Listings owned by anyone are third-party code — review before forking.',
		keywords: [
			'community',
			'publish',
			'listing',
			'share',
			'marketplace',
			'package',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id to publish as a public package.'),
		}),
		outputSchema: communityListingSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (existing) {
				await authorizePackageWrite(
					{ env: ctx.env, request: ctx.callerContext.request },
					{
						id: existing.id,
						userId: existing.userId,
						label: existing.name,
					},
					'package:publish',
				)
			}
			const listing = await publishCommunityListing({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				packageId: args.package_id,
			})
			return toCommunityListingSummaryOutput(listing, ctx.callerContext.baseUrl)
		},
	},
)

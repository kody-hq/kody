import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { reportCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityReportCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityReport',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'Report a public package to deployment admins. Reports include the reporter identity and are not anonymous.',
		keywords: ['community', 'report', 'abuse', 'moderation', 'listing'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Catalog entry id to report.'),
			reason: z
				.string()
				.min(1)
				.max(2000)
				.describe('Report reason (1–2000 characters).'),
		}),
		outputSchema: z.object({
			report_id: z.string(),
			listing_id: z.string(),
			status: z.literal('open'),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const report = await reportCommunityListing({
				env: ctx.env,
				// person-keyed (not personal org)
				userId: personalOrgId(user.userId),
				listingId: args.listing_id,
				reason: args.reason,
			})
			return {
				report_id: report.id,
				listing_id: report.listingId,
				status: 'open' as const,
			}
		},
	},
)

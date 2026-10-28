import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listCommunityActivityForAdmin } from '#worker/community/service.ts'
import {
	communityActivityKinds,
	type CommunityActivityRecord,
} from '#worker/community/types.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const commonActivityFields = {
	id: z.string(),
	listing_id: z.string(),
	listing_name: z.string(),
	listing_kody_id: z.string(),
	acting_username: z.string().nullable(),
	occurred_at: z.string(),
}

const communityActivitySchema = z.discriminatedUnion('kind', [
	z.object({
		...commonActivityFields,
		kind: z.literal('fork'),
	}),
	z.object({
		...commonActivityFields,
		kind: z.literal('rating'),
		stars: z.number().int().min(1).max(5),
		adaptation_effort: z.number().int().min(1).max(5),
	}),
])

function formatCommunityActivity(activity: CommunityActivityRecord) {
	const common = {
		id: activity.id,
		listing_id: activity.listingId,
		listing_name: activity.listingName,
		listing_kody_id: activity.listingKodyId,
		acting_username: activity.actingUsername,
		occurred_at: activity.occurredAt,
	}
	switch (activity.kind) {
		case 'fork':
			return { ...common, kind: activity.kind }
		case 'rating':
			return {
				...common,
				kind: activity.kind,
				stars: activity.stars,
				adaptation_effort: activity.adaptationEffort,
			}
		default: {
			const exhaustive: never = activity
			throw new Error(`Unsupported community activity: ${String(exhaustive)}`)
		}
	}
}

export const adminCommunityActivityListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminCommunityActivityList',
		contextRuns: 'deny',
		description:
			'List admin-only metadata about who forked or rated public packages in the Community catalog and when. Fork rows include both agent forks and one-click installs because the existing data model records both identically. Returns no package source, rating notes, secrets, or unrelated user content.',
		keywords: [
			'admin',
			'community',
			'activity',
			'forks',
			'installs',
			'ratings',
		],
		inputSchema: z.object({
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe('One-indexed activity page. Defaults to 1.'),
			pageSize: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe(
					'Community activity records per page. Defaults to 20 and maxes at 100.',
				),
			kind: z
				.enum(communityActivityKinds)
				.optional()
				.describe('Optional exact activity kind filter.'),
			listing_id: z
				.string()
				.min(1)
				.optional()
				.describe('Optional exact Community catalog entry id filter.'),
		}),
		outputSchema: z.object({
			total: z.number().int().nonnegative(),
			page: z.number().int().positive(),
			pageSize: z.number().int().positive(),
			activity: z.array(communityActivitySchema),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCommunityActivityList',
				async () => {
					const result = await listCommunityActivityForAdmin({
						db: ctx.env.APP_DB,
						page: args.page,
						pageSize: args.pageSize,
						kind: args.kind,
						listingId: args.listing_id,
					})
					return {
						total: result.total,
						page: result.page,
						pageSize: result.pageSize,
						activity: result.items.map(formatCommunityActivity),
					}
				},
			)
		},
	},
)

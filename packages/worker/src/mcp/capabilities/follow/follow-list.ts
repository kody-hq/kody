import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listFollowRecentUpdates } from '#worker/follow/repo.ts'
import { listFollowsForOrg } from '#worker/follow/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { describeFollowRecentUpdate } from '#universal/follows.ts'
import { followRecentUpdateSchema, followViewSchema } from './shared.ts'

const followListRecentUpdatesLimit = 20

export const followListCapability = defineDomainCapability(
	capabilityDomainNames.follow,
	{
		name: 'followList',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'List follows owned by the org this connection is bound to. Each row is named by @handle/name. Status is active or paused. Paused follows stop receiving events until followAdd resumes them. recent_updates lists the newest follow events no enabled package subscription handled (Kody keeps them instead of dropping them). This list never includes internal ids.',
		keywords: [
			'follow',
			'follow_repo',
			'followList',
			'watch',
			'list follows',
			'follow.published',
			'follow.pushed',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			follows: z.array(followViewSchema),
			recent_updates: z
				.array(followRecentUpdateSchema)
				.describe(
					'Newest first, at most 20. Events no enabled package subscription in this org handled.',
				),
		}),
		async handler(_args, ctx) {
			requireMcpUser(ctx.callerContext)
			const followerOrgId = ownerIdFromCaller(ctx.callerContext)
			const [follows, updates] = await Promise.all([
				listFollowsForOrg({ db: ctx.env.APP_DB, followerOrgId }),
				listFollowRecentUpdates(ctx.env.APP_DB, {
					followerOrgId,
					limit: followListRecentUpdatesLimit,
				}),
			])
			return {
				follows,
				recent_updates: updates.map((update) => ({
					name: update.targetName,
					kind: update.targetKind,
					event: update.detail.event,
					occurred_at: update.occurredAt,
					summary: describeFollowRecentUpdate(update.detail),
				})),
			}
		},
	},
)

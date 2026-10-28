import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { removeFollow } from '#worker/follow/service.ts'
import { followTargetKinds } from '#worker/follow/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { followViewSchema } from './shared.ts'

export const followRemoveCapability = defineDomainCapability(
	capabilityDomainNames.follow,
	{
		name: 'followRemove',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'Unfollow a package or plain repo by @handle/name for the org this connection is bound to. Works for paused follows too, including ones whose target was deleted. Returns the removed follow.',
		keywords: [
			'follow',
			'follow_repo',
			'followRemove',
			'unfollow',
			'stop following',
			'unwatch',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe('Followed target, as @handle/name (see followList).'),
			kind: z
				.enum(followTargetKinds)
				.optional()
				.describe('package or repo, when the org follows both names.'),
		}),
		outputSchema: z.object({
			removed: followViewSchema,
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			return await removeFollow({
				env: ctx.env,
				followerOrgId: ownerIdFromCaller(ctx.callerContext),
				name: args.name,
				kind: args.kind,
			})
		},
	},
)

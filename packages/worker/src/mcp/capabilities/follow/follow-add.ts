import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { addFollow } from '#worker/follow/service.ts'
import { followTargetKinds } from '#worker/follow/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { followEventsSchema, followViewSchema } from './shared.ts'

export const followAddCapability = defineDomainCapability(
	capabilityDomainNames.follow,
	{
		name: 'followAdd',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'Follow a package or plain repo by @handle/name so this org receives follow.published when its live version moves and, when you can read it, follow.pushed when the default branch moves. Public targets are followable by any signed-in caller. Private targets require package:read (a use grant qualifies; execute-only does not) and a missing or unreadable target is reported as not found. Creating a follow that already exists returns it and, if it was paused, resumes it when you can still read the target. Pass events to choose published and/or pushed; omit them to keep the current choice (both for a new follow).',
		keywords: [
			'follow',
			'follow_repo',
			'followAdd',
			'watch',
			'subscribe',
			'follow.published',
			'follow.pushed',
			'@handle/name',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Target to follow, as @handle/name. handle is the owner org slug.',
				),
			kind: z
				.enum(followTargetKinds)
				.optional()
				.describe(
					'package or repo. Omit to follow the package when both exist under that name, otherwise the plain repo.',
				),
			events: followEventsSchema.optional(),
		}),
		outputSchema: z.object({
			follow: followViewSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const follow = await addFollow({
				env: ctx.env,
				followerOrgId: ownerIdFromCaller(ctx.callerContext),
				creatorUserId: user.userId,
				name: args.name,
				kind: args.kind,
				events: args.events,
			})
			return { follow }
		},
	},
)

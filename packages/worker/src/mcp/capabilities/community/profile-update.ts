import { z } from 'zod'
import { getUserSocialRowByStableId } from '#worker/community/profile-repo.ts'
import {
	getCommunityProfileByStableId,
	updateCommunityProfile,
} from '#worker/community/profile-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { callerContextFields } from '#mcp/observability.ts'
import {
	communityProfileOutputSchema,
	communityProfileVisibilitySchema,
	toCommunityProfileOutput,
} from './social-shared.ts'

export const communityProfileUpdateCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityProfileUpdate',
		contextRuns: 'allow',
		orgPermission: 'org:write',
		description:
			'Update your community profile display name, bio, and/or visibility. At least one field is required. Visibility private hides your profile from other users.',
		keywords: [
			'community',
			'profile',
			'update',
			'bio',
			'display name',
			'visibility',
			'private',
		],
		tags: ['community', 'profile'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				display_name: z
					.string()
					.max(50)
					.optional()
					.describe(
						'Display name shown on your profile. Empty string clears it.',
					),
				bio: z
					.string()
					.max(500)
					.optional()
					.describe('Short bio text. Empty string clears it.'),
				visibility: communityProfileVisibilitySchema
					.optional()
					.describe(
						'Profile visibility. Private profiles are hidden from other users.',
					),
			})
			.refine(
				(value) =>
					value.display_name !== undefined ||
					value.bio !== undefined ||
					value.visibility !== undefined,
				{
					message:
						'At least one of display_name, bio, or visibility is required.',
				},
			),
		outputSchema: communityProfileOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const socialRow = await getUserSocialRowByStableId(
				ctx.env.APP_DB,
				user.userId,
			)
			if (!socialRow) {
				throw new Error(
					'Community profile not found for the authenticated user.',
				)
			}

			await updateCommunityProfile({
				env: ctx.env,
				numericUserId: socialRow.id,
				displayName: args.display_name,
				bio: args.bio,
				visibility: args.visibility,
			})

			const profile = await getCommunityProfileByStableId({
				env: ctx.env,
				stableUserId: user.userId,
				includePrivate: true,
			})
			if (!profile) {
				throw new Error('Community profile not found after update.')
			}
			const { baseUrl } = callerContextFields(ctx.callerContext)
			return toCommunityProfileOutput(profile, baseUrl)
		},
	},
)

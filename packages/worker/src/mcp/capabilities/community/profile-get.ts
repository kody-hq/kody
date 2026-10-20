import { z } from 'zod'
import {
	getCommunityProfileByStableId,
	getCommunityProfileByUsername,
	getProfileActivity,
	listPublicProfilePackages,
} from '#worker/community/profile-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { callerContextFields } from '#mcp/observability.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { toCommunityActivityItemOutput } from './shared.ts'
import {
	communityProfileGetOutputSchema,
	toCommunityProfileOutput,
	toCommunityProfilePackageOutput,
} from './social-shared.ts'

const profilePackageLimit = 50
const profileActivityLimit = 20

export const communityProfileGetCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityProfileGet',
		orgPermission: 'org:read',
		description:
			'Load a community user profile with packages and recent activity. Omit username to load your own profile (includes a private profile and private, hidden, or unpublished packages). Other users see only public packages. Private profiles of other users return user_found false without leaking existence.',
		keywords: ['community', 'profile', 'user', 'bio', 'packages', 'activity'],
		tags: ['community', 'profile'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			username: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Username to load. Omit to load the authenticated caller’s own profile.',
				),
		}),
		outputSchema: communityProfileGetOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { baseUrl } = callerContextFields(ctx.callerContext)
			const requestedUsername = args.username
			const isSelfByUsername =
				requestedUsername !== undefined &&
				user.username != null &&
				requestedUsername.toLowerCase() === user.username.toLowerCase()
			const isSelf = requestedUsername === undefined || isSelfByUsername

			const profile =
				requestedUsername === undefined || isSelfByUsername
					? await getCommunityProfileByStableId({
							env: ctx.env,
							stableUserId: user.userId,
							includePrivate: true,
						})
					: await getCommunityProfileByUsername({
							env: ctx.env,
							username: requestedUsername,
							includePrivate: false,
						})

			if (!profile) {
				return {
					user_found: false,
					profile: null,
					packages: [],
					recent_activity: [],
				}
			}

			// Packages are keyed by personal org id; person id misses post-#3053 orgs.
			const identity = await findPublicOwnerIdentityByHandle({
				db: ctx.env.APP_DB,
				handle: profile.username,
			})
			const ownerOrgId =
				identity?.ownerId ??
				(await loadPersonalOrgIdForPerson(
					ctx.env.APP_DB,
					personIdFromStored(profile.userId),
				))

			const [packages, recentActivity] = await Promise.all([
				listPublicProfilePackages({
					env: ctx.env,
					ownerStableUserId: ownerOrgId,
					limit: profilePackageLimit,
					includePrivate: isSelf,
				}),
				getProfileActivity({
					env: ctx.env,
					actorUserId: profile.userId,
					limit: profileActivityLimit,
					isSelf,
				}),
			])

			return {
				user_found: true,
				profile: toCommunityProfileOutput(profile, baseUrl),
				packages: packages.map((pkg) =>
					toCommunityProfilePackageOutput(pkg, {
						includePackageId: isSelf,
					}),
				),
				recent_activity: recentActivity.map((item) =>
					toCommunityActivityItemOutput(item, baseUrl),
				),
			}
		},
	},
)

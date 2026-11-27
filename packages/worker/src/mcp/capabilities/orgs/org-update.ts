import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import {
	loadOrgMemberCreation,
	updateOrgMemberCreation,
} from '#worker/orgs/member-creation.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { updateOrgProfile } from '#worker/orgs/org-profile.ts'
import { loadOrgProfileVisibility } from '#worker/orgs/org-public-profile.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import {
	loadOrgUsageWarningsEnabled,
	updateOrgUsageWarnings,
} from '#worker/orgs/usage-warnings.ts'
import {
	loadOrgSessionAnalyticsState,
	updateOrgSessionAnalytics,
} from '#worker/session-analytics/consent.ts'
import { sessionAnalyticsStates } from '#universal/session-analytics.ts'
import { orgProfileVisibilitySchema } from '#worker/orgs/org-profile-visibility-schema.ts'

export const orgUpdateCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgUpdate',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		description:
			'Update the display name or page visibility of the organization this request is bound to. profile_visibility public shows kody.codes/@<slug> (name, photo, bio, public packages; never members) to everyone; private shows it only to members. The handle (slug, kody.codes/@<slug>) is permanent and cannot be changed; passing any other handle fails. Signup organizations keep the person’s account profile as their identity. In team organizations, members_can_create_packages (default false) lets every Member create packages, repos, and their apps, and members_can_create_credentials (default true) lets every Member add secrets, OAuth connections, and MCP servers; Owners always can, and package:create / secret:create / integration:create grants still work when a setting is off. usage_warnings (default true, personal and team orgs) controls the 80% and 100% usage emails and the once-a-month usage heads-up on hosted execute responses; false turns all of them off for the org. session_analytics (personal and team orgs, off until someone turns it on) is the opt-in to session analytics: true lets Kody count a general work category, the outcome, and the stuck point of agent sessions so Kody can improve, and false turns it off and deletes everything it stored for the org right away. This choice belongs to a person: relay the question and pass session_analytics only after an Owner or Admin has answered it, never on your own initiative.',
		keywords: [
			'org',
			'organization',
			'display name',
			'profile',
			'visibility',
			'public',
			'private',
			'member permissions',
			'members can create',
			'usage warnings',
			'usage warning',
			'usage alerts',
			'disable',
			'turn off',
			'stop',
			'email',
			'usage emails',
			'notifications',
			'opt out',
			'unsubscribe',
			'heads-up',
			'session analytics',
			'analytics opt in',
			'help improve kody',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			display_name: z.string().min(1).max(80).optional(),
			slug: z
				.string()
				.min(1)
				.describe(
					'Must match the current handle. Handles are permanent and cannot be changed.',
				)
				.optional(),
			profile_visibility: orgProfileVisibilitySchema.optional(),
			members_can_create_packages: z
				.boolean()
				.optional()
				.describe(
					'Team orgs only. Let every Member create packages, repos, and their apps.',
				),
			members_can_create_credentials: z
				.boolean()
				.optional()
				.describe(
					'Team orgs only. Let every Member add secrets, OAuth connections, and MCP servers.',
				),
			usage_warnings: z
				.boolean()
				.optional()
				.describe(
					'Personal and team orgs. Send the 80% and 100% usage emails and the monthly usage heads-up on execute responses (default true).',
				),
			session_analytics: z
				.boolean()
				.optional()
				.describe(
					'Personal and team orgs. The answer a person gave to the session analytics question. true opts the org in; false opts it out and deletes everything session analytics stored for it.',
				),
		}),
		outputSchema: z.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				display_name: z.string().nullable(),
				profile_visibility: orgProfileVisibilitySchema,
				members_can_create_packages: z.boolean(),
				members_can_create_credentials: z.boolean(),
				usage_warnings: z.boolean(),
				session_analytics: z.enum(sessionAnalyticsStates),
			}),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			const touchesProfile =
				args.display_name !== undefined ||
				args.slug !== undefined ||
				args.profile_visibility !== undefined ||
				args.members_can_create_packages !== undefined ||
				args.members_can_create_credentials !== undefined
			if (
				!touchesProfile &&
				args.usage_warnings === undefined &&
				args.session_analytics === undefined
			) {
				throw new McpCallerError(
					'Pass display_name, slug, profile_visibility, members_can_create_packages, members_can_create_credentials, usage_warnings, or session_analytics.',
				)
			}
			const updated = touchesProfile
				? await updateOrgProfile(ctx.env.APP_DB, {
						orgId: request.org.id,
						displayName: args.display_name,
						slug: args.slug,
						profileVisibility: args.profile_visibility,
						...(args.profile_visibility === undefined
							? {}
							: { audit: orgAuditWriterFromRequest(ctx.env, request) }),
					})
				: await readOrgIdentity(ctx.env.APP_DB, request.org.id)
			if (!updated.ok) {
				throw new McpCallerError(updated.error)
			}
			// updateOrgProfile already refused personal orgs for member settings.
			const memberCreation =
				args.members_can_create_packages === undefined &&
				args.members_can_create_credentials === undefined
					? null
					: await updateOrgMemberCreation(ctx.env.APP_DB, {
							orgId: request.org.id,
							packages: args.members_can_create_packages,
							credentials: args.members_can_create_credentials,
							audit: orgAuditWriterFromRequest(ctx.env, request),
						})
			if (memberCreation && !memberCreation.ok) {
				throw new McpCallerError(memberCreation.error)
			}
			const usageWarnings =
				args.usage_warnings === undefined
					? null
					: await updateOrgUsageWarnings(ctx.env.APP_DB, {
							orgId: request.org.id,
							enabled: args.usage_warnings,
							audit: orgAuditWriterFromRequest(ctx.env, request),
						})
			if (usageWarnings && !usageWarnings.ok) {
				throw new McpCallerError(usageWarnings.error)
			}
			const sessionAnalytics =
				args.session_analytics === undefined
					? null
					: await updateOrgSessionAnalytics(ctx.env.APP_DB, {
							orgId: request.org.id,
							enabled: args.session_analytics,
							audit: orgAuditWriterFromRequest(ctx.env, request),
						})
			if (sessionAnalytics && !sessionAnalytics.ok) {
				throw new McpCallerError(sessionAnalytics.error)
			}
			const settings = memberCreation?.ok
				? memberCreation.settings
				: await loadOrgMemberCreation(ctx.env.APP_DB, request.org.id)
			return {
				org: {
					id: request.org.id,
					slug: updated.slug,
					display_name: updated.displayName,
					profile_visibility: updated.profileVisibility,
					members_can_create_packages: settings.packages,
					members_can_create_credentials: settings.credentials,
					usage_warnings: usageWarnings?.ok
						? usageWarnings.enabled
						: await loadOrgUsageWarningsEnabled(ctx.env.APP_DB, request.org.id),
					session_analytics: sessionAnalytics?.ok
						? sessionAnalytics.state
						: await loadOrgSessionAnalyticsState(
								ctx.env.APP_DB,
								request.org.id,
							),
				},
			}
		},
	},
)

async function readOrgIdentity(db: D1Database, orgId: string) {
	const org = await getOrgById(db, orgId)
	if (!org) return { ok: false as const, error: 'Organization was not found.' }
	return {
		ok: true as const,
		slug: org.slug,
		displayName: org.display_name,
		profileVisibility: await loadOrgProfileVisibility(db, orgId),
	}
}

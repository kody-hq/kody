import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { updateOrgProfile } from '#worker/orgs/org-profile.ts'
import { orgProfileVisibilitySchema } from '#worker/orgs/org-profile-visibility-schema.ts'

export const orgUpdateCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgUpdate',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		description:
			'Update the display name or page visibility of the organization this request is bound to. profile_visibility public shows kody.codes/@<slug> (name, photo, bio, public packages; never members) to everyone; private shows it only to members. The handle (slug, kody.codes/@<slug>) is permanent and cannot be changed; passing any other handle fails. Signup organizations keep the person’s account profile as their identity.',
		keywords: [
			'org',
			'organization',
			'display name',
			'profile',
			'visibility',
			'public',
			'private',
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
		}),
		outputSchema: z.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				display_name: z.string().nullable(),
				profile_visibility: orgProfileVisibilitySchema,
			}),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (
				args.display_name === undefined &&
				args.slug === undefined &&
				args.profile_visibility === undefined
			) {
				throw new McpCallerError(
					'Pass display_name, slug, or profile_visibility.',
				)
			}
			const updated = await updateOrgProfile(ctx.env.APP_DB, {
				orgId: request.org.id,
				displayName: args.display_name,
				slug: args.slug,
				profileVisibility: args.profile_visibility,
				...(args.profile_visibility === undefined
					? {}
					: { audit: orgAuditWriterFromRequest(ctx.env, request) }),
			})
			if (!updated.ok) {
				throw new McpCallerError(updated.error)
			}
			return {
				org: {
					id: request.org.id,
					slug: updated.slug,
					display_name: updated.displayName,
					profile_visibility: updated.profileVisibility,
				},
			}
		},
	},
)

import { z } from 'zod'
import { loadAdminUserOauthGrants } from '#worker/admin/user-oauth-grants.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to look up.'),
		username: z.string().min(1).optional().describe('Username to look up.'),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const grantSchema = z.object({
	grantId: z.string(),
	clientId: z.string(),
	boundOrgId: z
		.string()
		.nullable()
		.describe(
			"Org id stamped on the grant (metadata.orgId). Pre-stamp grants fall back to the person's personal org id.",
		),
	createdAt: z.string().nullable(),
	lastUsedAt: z
		.string()
		.nullable()
		.describe('Last successful MCP use for this client id, when known.'),
	scope: z.array(z.string()),
})

const outputSchema = z.object({
	result: z
		.object({
			stableUserId: stableUserIdSchema,
			username: z.string(),
			email: z.string(),
			grants: z.array(grantSchema),
			listingFailed: z
				.boolean()
				.describe(
					'True when OAuth helpers were unavailable or listing threw; grants is then empty.',
				),
		})
		.nullable(),
})

export const adminUserOauthGrantsCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminUserOauthGrants',
		contextRuns: 'deny',
		description:
			"List one person's MCP OAuth grants with client id, bound org id, created time, and last-used time. Bound org prefers stamped metadata.orgId; older grants fall back to the personal org id. Admin-only; never returns tokens or user content.",
		keywords: [
			'admin',
			'oauth',
			'grants',
			'mcp',
			'bindings',
			'org',
			'connections',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserOauthGrants',
				async () => ({
					result: await loadAdminUserOauthGrants({
						env: ctx.env,
						target: {
							stableUserId: args.stableUserId,
							email: args.email,
							username: args.username,
						},
					}),
				}),
			)
		},
	},
)

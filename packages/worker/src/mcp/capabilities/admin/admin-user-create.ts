import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AdminCreateUserError,
	adminCreateUserWithPasswordSetup,
} from '#worker/identity/admin-user-creation.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	buildCreatedUserAuditReason,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z.object({
	email: z
		.string()
		.trim()
		.min(3)
		.max(254)
		.describe(
			'Account email (name@domain). Must be syntactically valid. Disposable domains, mistyped domains (with a suggestion when one is known), and domains with no MX and no A/AAAA record are rejected. A domain lookup that times out is allowed.',
		),
	username: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional username. When omitted, Kody generates an available username from the email local part.',
		),
})

const outputSchema = z.object({
	createdUser: z.object({
		stableUserId: stableUserIdSchema,
		email: z.string(),
		username: z.string(),
		setupLink: z.string(),
		setupTokenExpiresAt: z.number().int().positive(),
	}),
})

export const adminUserCreateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUserCreate',
		description:
			'Create one user account by email, assign the default user role, and return a password setup link. The email must be a real address: syntactically valid, not a disposable domain, not a common typo (the error suggests the corrected address), and the domain must have an MX record or an A/AAAA fallback. Admin-only; does not send mail and does not expose user content.',
		keywords: ['admin', 'user', 'create', 'account', 'email', 'password setup'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserCreate',
				async () => {
					let createdUser: Awaited<
						ReturnType<typeof adminCreateUserWithPasswordSetup>
					>
					try {
						createdUser = await adminCreateUserWithPasswordSetup({
							db: ctx.env.APP_DB,
							env: ctx.env,
							email: args.email,
							username: args.username,
							setupLinkOrigin: ctx.callerContext.baseUrl,
						})
					} catch (error) {
						if (error instanceof AdminCreateUserError) {
							throw new McpCallerError(error.message)
						}
						throw error
					}
					scheduleUserCreatedEvent({
						env: ctx.env,
						user: {
							id: createdUser.stableUserId,
							username: createdUser.username,
							email: createdUser.email,
						},
						source: 'admin',
					})
					const { userId: _userId, ...boundaryUser } = createdUser
					return { createdUser: boundaryUser }
				},
				{
					successReason: ({ createdUser }) =>
						buildCreatedUserAuditReason({
							stableUserId: createdUser.stableUserId,
							email: createdUser.email,
						}),
				},
			)
		},
	},
)

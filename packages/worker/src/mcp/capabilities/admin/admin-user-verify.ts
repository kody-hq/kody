import { z } from 'zod'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from '#worker/identity/email-verification-admin.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to verify.'),
		username: z.string().min(1).optional().describe('Username to verify.'),
		action: z
			.enum(['mark_verified', 'mint_verify_url'])
			.describe(
				'mark_verified sets email_verified_at after operator-confirmed ownership. mint_verify_url returns a one-time /verify-email link without sending kody.codes mail.',
			),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	user: adminUserMetadataSchema,
	verifyUrl: z
		.string()
		.nullable()
		.describe(
			'One-time verification URL when action is mint_verify_url; otherwise null.',
		),
	expiresAt: z
		.number()
		.int()
		.nullable()
		.describe('Unix ms expiry of the minted token, or null.'),
})

export const adminUserVerifyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUserVerify',
		contextRuns: 'deny',
		description:
			'Mark one account email verified, or mint a one-time verify URL to send over a path that is not kody.codes. Admin-only; audited; never touches user content.',
		keywords: [
			'admin',
			'user',
			'verify',
			'email verification',
			'bounce',
			'fastmail',
			'mark verified',
			'verify link',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserVerify',
				async () => {
					const target = {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
					}
					try {
						if (args.action === 'mark_verified') {
							const user = await markAdminUserEmailVerified(
								ctx.env.APP_DB,
								target,
							)
							return { user, verifyUrl: null, expiresAt: null }
						}
						const minted = await mintAdminEmailVerificationUrl({
							db: ctx.env.APP_DB,
							appBaseUrl: ctx.callerContext.baseUrl,
							target,
						})
						return {
							user: minted.user,
							verifyUrl: minted.verifyUrl,
							expiresAt: minted.expiresAt,
						}
					} catch (error) {
						// Missing users / already-verified are caller-clearable.
						if (error instanceof AdminEmailVerificationError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};action=${args.action}`,
				},
			)
		},
	},
)

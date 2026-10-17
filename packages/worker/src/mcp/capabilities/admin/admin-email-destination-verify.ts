import { z } from 'zod'
import {
	AdminEmailDestinationVerificationError,
	markAdminEmailDestinationVerified,
} from '#worker/email/destination-verification-admin.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'
import {
	emailDestinationSchema,
	toEmailDestination,
} from '../email/email-destination-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z
			.string()
			.email()
			.optional()
			.describe('Account identity email of the destination owner.'),
		username: z
			.string()
			.min(1)
			.optional()
			.describe('Username of the destination owner.'),
		destinationEmail: z
			.string()
			.email()
			.describe(
				'Additional destination address to mark verified after operator-confirmed ownership.',
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
	destination: emailDestinationSchema,
})

export const adminEmailDestinationVerifyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminEmailDestinationVerify',
		description:
			'Mark one additional email destination verified after the operator confirms ownership (for example the person replied from that address to their inbox). Use when destination verification mail never arrives, including when the account is younger than 24 hours or a verification-mail cap blocked the send. Admin-only; audited; does not send mail and does not consume the new-account wait or those caps.',
		keywords: [
			'admin',
			'email destination',
			'verify',
			'mark verified',
			'destination verification',
			'unblock',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminEmailDestinationVerify',
				async () => {
					const target = {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
					}
					try {
						const result = await markAdminEmailDestinationVerified({
							db: ctx.env.APP_DB,
							target,
							destinationEmail: args.destinationEmail,
						})
						return {
							user: result.user,
							destination: toEmailDestination(result.destination),
						}
					} catch (error) {
						// Missing user/destination and invalid email are caller-clearable.
						if (error instanceof AdminEmailDestinationVerificationError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: ({ user, destination }) =>
						`target_stable_user_id=${user.stableUserId};destination=${destination.email}`,
				},
			)
		},
	},
)

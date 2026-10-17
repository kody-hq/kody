import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createEmailDestinationVerification } from '#worker/email/destination-verification.ts'
import { loadEmailDestinationAccount } from '#worker/email/destinations.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import {
	emailDestinationSchema,
	mapEmailDestinationError,
	toEmailDestination,
} from './email-destination-shared.ts'

export const emailDestinationAddCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDestinationAdd',
		orgPermission: 'email:write',
		description:
			'Start verification for an additional email destination. Mail comes from your platform address; destinations expand the allowed to set. The address cannot receive mail until the owner opens the verification link. Re-adding an unverified address resends the link. Cap is 5 extras besides the account email. The account must be at least 24 hours old. Verification mail is limited to 3 requests every 15 minutes, 10 per user per rolling 24 hours, and 3 per recipient address per rolling 24 hours across all accounts. A blocked send names the limit and the UTC time to retry, and still saves the address so a later retry or adminEmailDestinationVerify can finish it. Use a different address when the recipient cap is hit, or contact support if the account needs an address sooner.',
		keywords: ['email', 'destination', 'add', 'verify', 'send'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			email: z.string().min(1),
		}),
		outputSchema: z.object({
			destination: emailDestinationSchema,
			created: z.boolean(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const account = await loadEmailDestinationAccount({
				db: ctx.env.APP_DB,
				stableUserId: user.userId,
			})
			if (!account) {
				throw new Error('Account was not found.')
			}
			try {
				const result = await createEmailDestinationVerification({
					env: ctx.env,
					userId: account.id,
					email: args.email,
					requestUrl: ctx.callerContext.baseUrl,
				})
				return {
					destination: toEmailDestination(result.destination),
					created: result.created,
					message: result.created
						? 'Verification email sent. The address cannot receive emailSend mail until it is verified.'
						: 'Verification email resent. The address cannot receive emailSend mail until it is verified.',
				}
			} catch (error) {
				mapEmailDestinationError(error)
			}
		},
	},
)

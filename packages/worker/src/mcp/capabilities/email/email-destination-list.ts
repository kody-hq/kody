import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import {
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
} from '#worker/email/destinations.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import {
	emailDestinationSchema,
	toEmailDestination,
} from './email-destination-shared.ts'

export const emailDestinationListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDestinationList',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'List email destinations emailSend may use. Mail comes from your platform address. The account identity email is always included. Extra addresses must be verified before emailSend can use them.',
		keywords: ['email', 'destination', 'send', 'default', 'address'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			destinations: z.array(emailDestinationSchema),
			additional_limit: z.number(),
			additional_remaining: z.number(),
		}),
		async handler(_args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const destinations = await listEmailNotificationDestinations({
				db: ctx.env.APP_DB,
				stableUserId: user.userId,
				accountEmail: user.email,
				accountEmailVerified: true,
			})
			const additionalCount = destinations.filter(
				(destination) => destination.kind === 'additional',
			).length
			return {
				destinations: destinations.map(toEmailDestination),
				additional_limit: maxAdditionalEmailNotificationDestinations,
				additional_remaining: Math.max(
					0,
					maxAdditionalEmailNotificationDestinations - additionalCount,
				),
			}
		},
	},
)

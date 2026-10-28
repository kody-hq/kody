import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	loadEmailDestinationAccount,
	removeEmailNotificationDestination,
} from '#worker/email/destinations.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import {
	emailDestinationSchema,
	mapEmailDestinationError,
	toEmailDestination,
} from './email-destination-shared.ts'

export const emailDestinationRemoveCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDestinationRemove',
		contextRuns: 'allow',
		orgPermission: 'email:write',
		description:
			'Remove an additional email destination. The account identity email cannot be removed. If the removed address was the default, emailSend without `to` falls back to the identity email.',
		keywords: ['email', 'destination', 'remove', 'delete'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			id: z.string().min(1),
		}),
		outputSchema: z.object({
			destinations: z.array(emailDestinationSchema),
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
				const destinations = await removeEmailNotificationDestination({
					db: ctx.env.APP_DB,
					dbUserId: account.id,
					destinationId: args.id,
				})
				return { destinations: destinations.map(toEmailDestination) }
			} catch (error) {
				mapEmailDestinationError(error)
			}
		},
	},
)

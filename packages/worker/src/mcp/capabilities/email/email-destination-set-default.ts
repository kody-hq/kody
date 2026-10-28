import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	loadEmailDestinationAccount,
	setDefaultEmailNotificationDestination,
} from '#worker/email/destinations.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import {
	emailDestinationSchema,
	mapEmailDestinationError,
	toEmailDestination,
} from './email-destination-shared.ts'

export const emailDestinationSetDefaultCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDestinationSetDefault',
		contextRuns: 'allow',
		orgPermission: 'email:write',
		description:
			'Set the default email destination used when emailSend omits `to`. Pass the identity id or a verified additional destination id from emailDestinationList.',
		keywords: ['email', 'destination', 'default', 'notify'],
		readOnly: false,
		idempotent: true,
		destructive: false,
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
				const destinations = await setDefaultEmailNotificationDestination({
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

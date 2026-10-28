import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import {
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
} from '#worker/email/repo.ts'
import { emailInboxListSchema } from './shared.ts'

export const emailInboxListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailInboxList',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'List email inboxes and automatic platform addresses for the current org.',
		keywords: ['email', 'inbox', 'address', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: emailInboxListSchema,
		async handler(_args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const ownerId = emailOwnerOrgId(ctx, user)
			const [inboxes, addresses] = await Promise.all([
				listEmailInboxesForUser({ db: ctx.env.APP_DB, userId: ownerId }),
				listEmailInboxAddressesForUser({
					db: ctx.env.APP_DB,
					userId: ownerId,
				}),
			])
			return {
				inboxes: inboxes.map((inbox) => ({
					id: inbox.id,
					name: inbox.name,
					description: inbox.description,
					enabled: inbox.enabled,
					addresses: addresses
						.filter((address) => address.inboxId === inbox.id)
						.map((address) => ({
							id: address.id,
							address: address.address,
							enabled: address.enabled,
							created_at: address.createdAt,
						})),
					created_at: inbox.createdAt,
					updated_at: inbox.updatedAt,
				})),
			}
		},
	},
)

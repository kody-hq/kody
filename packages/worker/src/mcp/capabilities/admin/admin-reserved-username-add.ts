import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	addReservedUsernames,
	InvalidReservedUsernameError,
	loadReservedUsernameAdminSnapshot,
} from '#worker/identity/reserved-username-settings.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import {
	reservedUsernamesInputSchema,
	reservedUsernamesSnapshotSchema,
} from './reserved-username-shared.ts'

const outputSchema = z.object({
	reservedUsernames: reservedUsernamesSnapshotSchema,
})

export const adminReservedUsernameAddCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminReservedUsernameAdd',
		contextRuns: 'deny',
		description:
			'Add DNS-safe usernames to the runtime reserved list stored in platform KV, or restore previously unreserved built-in names. Admin-only; never returns user content beyond the reserved-username snapshot.',
		keywords: ['admin', 'reserved username', 'username', 'denylist', 'add'],
		inputSchema: reservedUsernamesInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminReservedUsernameAdd',
				async () => {
					const admin = await resolveActingAdminPerson(ctx)
					try {
						await addReservedUsernames({
							env: ctx.env,
							usernames: args.usernames,
							updatedBy: admin.stableUserId,
						})
					} catch (error) {
						if (error instanceof InvalidReservedUsernameError) {
							throw new Error(error.message)
						}
						throw error
					}
					return {
						reservedUsernames: await loadReservedUsernameAdminSnapshot(ctx.env),
					}
				},
				{
					successReason: ({ reservedUsernames }) =>
						`added=${reservedUsernames.added.length};removed=${reservedUsernames.removed.length}`,
				},
			)
		},
	},
)

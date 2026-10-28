import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	InvalidReservedUsernameError,
	loadReservedUsernameAdminSnapshot,
	PermanentlyReservedUsernameError,
	removeReservedUsernames,
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

export const adminReservedUsernameRemoveCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminReservedUsernameRemove',
		contextRuns: 'deny',
		description:
			'Remove custom reserved usernames or unreserve built-in names that are not permanently locked (system-email locals and kody-prefixed built-ins). Admin-only; never returns user content beyond the reserved-username snapshot.',
		keywords: ['admin', 'reserved username', 'username', 'denylist', 'remove'],
		inputSchema: reservedUsernamesInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminReservedUsernameRemove',
				async () => {
					const admin = await resolveActingAdminPerson(ctx)
					try {
						await removeReservedUsernames({
							env: ctx.env,
							usernames: args.usernames,
							updatedBy: admin.stableUserId,
						})
					} catch (error) {
						if (
							error instanceof PermanentlyReservedUsernameError ||
							error instanceof InvalidReservedUsernameError
						) {
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

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { loadReservedUsernameAdminSnapshot } from '#worker/identity/reserved-username-settings.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { reservedUsernamesSnapshotSchema } from './reserved-username-shared.ts'

const outputSchema = z.object({
	reservedUsernames: reservedUsernamesSnapshotSchema,
})

export const adminReservedUsernameListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminReservedUsernameList',
		contextRuns: 'deny',
		description:
			'List the built-in reserved usernames, runtime KV additions and removals, and registered usernames that collide with the effective reserved set. Admin-only; never returns emails or other account content beyond username and stable user id for conflicts.',
		keywords: [
			'admin',
			'reserved username',
			'username',
			'denylist',
			'conflicts',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminReservedUsernameList',
				async () => ({
					reservedUsernames: await loadReservedUsernameAdminSnapshot(ctx.env),
				}),
				{
					successReason: ({ reservedUsernames }) =>
						`added=${reservedUsernames.added.length};removed=${reservedUsernames.removed.length};conflicts=${reservedUsernames.conflicts.length}`,
				},
			)
		},
	},
)

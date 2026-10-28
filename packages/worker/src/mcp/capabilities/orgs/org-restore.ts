import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	assertActorCanRestoreSoftDeletedOrg,
	OrgRestoreWindowExpiredError,
	restoreOrg,
} from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z.string().min(1).describe('Soft-deleted organization id to restore.'),
})

const outputSchema = z.object({
	orgId: z.string(),
})

export const orgRestoreCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgRestore',
		description:
			'Restore a soft-deleted organization within the 30-day retention window. Authorization uses the actor’s Owner membership from the deletion generation (the org cannot be bound while tombstoned) and still requires `org:delete` on scoped credentials.',
		keywords: ['org', 'restore', 'undelete', 'team'],
		// Soft-deleted orgs are not bindable; authorize in the handler.
		contextRuns: 'deny',
		orgPermission: 'none',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const scopes = request.credential.scopes
			if (scopes && !scopes.includes('org:delete')) {
				throw new McpCallerError(
					'This credential is not scoped for org:delete.',
				)
			}
			try {
				await assertActorCanRestoreSoftDeletedOrg({
					db: ctx.env.APP_DB,
					orgId: args.orgId as OwnerId,
					actorUserId: user.userId,
				})
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === 'org_restore_forbidden'
				) {
					throw new McpCallerError(
						'Only an Owner of the soft-deleted organization can restore it.',
					)
				}
				throw error
			}
			try {
				await restoreOrg({
					env: ctx.env,
					orgId: args.orgId as OwnerId,
					actorUserId: user.userId,
				})
			} catch (error) {
				if (error instanceof OrgRestoreWindowExpiredError) {
					throw new McpCallerError(
						'The 30-day restore window for this organization has expired.',
					)
				}
				if (error instanceof FreeOrgLimitError) {
					throw new McpCallerError(error.message)
				}
				if (
					error instanceof Error &&
					(error.message === 'org_restore_race' ||
						error.message === 'org_not_deleted')
				) {
					throw new McpCallerError(
						'That organization was already restored. Try again.',
					)
				}
				throw error
			}
			return { orgId: args.orgId }
		},
	},
)

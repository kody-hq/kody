import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	assertActorCanRestoreSoftDeletedOrg,
	OrgRestoreWindowExpiredError,
	restoreResourceRow,
} from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z
		.string()
		.min(1)
		.describe(
			'Soft-deleted organization id that owns the resource. Must match the soft-deleted org the actor can restore.',
		),
	resourceType: z
		.string()
		.min(1)
		.describe('Resource type key (for example package, secret, email).'),
	resourceId: z.string().min(1),
})

const outputSchema = z.object({
	restored: z.boolean(),
})

export const resourceRestoreCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'resourceRestore',
		description:
			'Restore one soft-deleted org-owned resource row while the org is still within the restore window. Soft-deleted orgs cannot be bound, so authorization mirrors orgRestore (deletion-generation Owner + `org:write` on scoped credentials). Minimal stub for P7; expands with resource-specific permissions later.',
		keywords: ['org', 'restore', 'resource', 'soft delete'],
		// Soft-deleted orgs are not bindable; authorize in the handler.
		contextRuns: 'deny',
		orgPermission: 'none',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const scopes = request.credential.scopes
			if (scopes && !scopes.includes('org:write')) {
				throw new McpCallerError('This credential is not scoped for org:write.')
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
						'Only an Owner of the soft-deleted organization can restore its resources.',
					)
				}
				throw error
			}
			try {
				return await restoreResourceRow({
					env: ctx.env,
					orgId: args.orgId as OwnerId,
					resourceType: args.resourceType,
					resourceId: args.resourceId,
				})
			} catch (error) {
				if (error instanceof OrgRestoreWindowExpiredError) {
					throw new McpCallerError(
						'The 30-day restore window for this organization has expired.',
					)
				}
				throw error
			}
		},
	},
)

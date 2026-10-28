/**
 * soft-delete-read-filter: opt-out
 *
 * Admin restore must read tombstoned orgs (and check personal-org ownership
 * across soft-deleted person rows) before calling restoreOrg.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import {
	OrgRestoreWindowExpiredError,
	restoreOrg,
} from '#worker/orgs/soft-delete.ts'
import {
	adminMutationCapabilityAccess,
	adminStableOwnerId,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z.object({
	org_id: stableUserIdSchema.describe(
		'Soft-deleted organization id (orgs.id) to restore.',
	),
	reason: z
		.string()
		.min(10)
		.describe(
			'Audit reason for restoring on behalf of former Owners, at least 10 characters.',
		),
})

const outputSchema = z.object({
	orgId: z.string(),
	slug: z.string(),
	restoredAt: z.string(),
})

/**
 * Operator restore when the former Owner cannot use the account UI (support
 * recovery). Does not require the admin to have been an Owner; still refuses
 * after the 30-day window and free-org cap checks inside {@link restoreOrg}.
 */
export const adminOrgRestoreCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgRestore',
		contextRuns: 'deny',
		description:
			'Restore a soft-deleted organization within the 30-day retention window as a site admin. Prefer the owner-facing Organizations restore UI when the former Owner can act. Admin-only and destructive.',
		keywords: [
			'admin',
			'org',
			'restore',
			'undelete',
			'soft delete',
			'recovery',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrgRestore',
				async () => {
					const orgId = adminStableOwnerId(args.org_id) as OwnerId
					const org = await ctx.env.APP_DB.prepare(
						`SELECT slug, deleted_at FROM orgs WHERE id = ?`,
					)
						.bind(orgId)
						.first<{ slug: string; deleted_at: string | null }>()
					if (!org) {
						throw new McpCallerError('Organization not found.')
					}
					if (!org.deleted_at) {
						throw new McpCallerError('That organization is not soft-deleted.')
					}
					// Refuse personal orgs: those restore with the person account.
					const personal = await ctx.env.APP_DB.prepare(
						`SELECT 1 AS ok FROM users
						 WHERE stable_user_id = ? OR personal_org_id = ?`,
					)
						.bind(orgId, orgId)
						.first<{ ok: number }>()
					if (personal) {
						throw new McpCallerError(
							'Personal organizations restore with the account, not adminOrgRestore.',
						)
					}
					try {
						const restored = await restoreOrg({
							env: ctx.env,
							orgId,
							actorUserId: ctx.callerContext.user?.userId ?? null,
							actorUsername: ctx.callerContext.user?.username ?? null,
						})
						return {
							orgId: restored.orgId,
							slug: org.slug,
							restoredAt: restored.restoredAt,
						}
					} catch (error) {
						if (error instanceof OrgRestoreWindowExpiredError) {
							throw new McpCallerError(
								'The 30-day restore window for this organization has expired.',
							)
						}
						if (error instanceof FreeOrgLimitError) {
							throw new McpCallerError(error.message)
						}
						if (error instanceof Error && error.message === 'org_not_deleted') {
							throw new McpCallerError('That organization is not soft-deleted.')
						}
						if (
							error instanceof Error &&
							error.message === 'org_restore_race'
						) {
							throw new McpCallerError(
								'That organization was already restored. Try again.',
							)
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						`org_id=${result.orgId};slug=${result.slug};reason=${args.reason}`,
				},
			)
		},
	},
)

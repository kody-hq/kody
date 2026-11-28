import { z } from 'zod'
import {
	cleanupMemberlessTeamOrgs,
	memberlessTeamOrgCleanupDefaultLimit,
	memberlessTeamOrgCleanupMaxLimit,
} from '#worker/orgs/memberless-team-orgs.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

export const adminMemberlessTeamOrgsCleanupCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminMemberlessTeamOrgsCleanup',
		contextRuns: 'deny',
		description:
			'Admin-only maintenance for live team organizations that have no live members (leftovers from account deletions that removed the last member without deleting the organization). Personal organizations and creator-less platform organizations are never matched. dryRun defaults to true and only lists them with a package count. With dryRun false, each listed organization is soft-deleted and then hard-purged immediately, packages included; this cannot be undone. Audited.',
		keywords: [
			'admin',
			'organization',
			'team',
			'memberless',
			'orphan',
			'cleanup',
			'maintenance',
		],
		destructive: true,
		inputSchema: z.object({
			dryRun: z
				.boolean()
				.optional()
				.describe(
					'Defaults to true (list only). Set false to soft-delete and hard-purge the listed organizations.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(memberlessTeamOrgCleanupMaxLimit)
				.optional()
				.describe(
					`Organizations to list or purge in this pass (default ${memberlessTeamOrgCleanupDefaultLimit}).`,
				),
			org_ids: z
				.array(z.string().min(1))
				.min(1)
				.max(memberlessTeamOrgCleanupMaxLimit)
				.optional()
				.describe(
					'Optional organization ids to inspect. Ids that are not memberless team organizations are skipped.',
				),
		}),
		outputSchema: z.object({
			dryRun: z.boolean(),
			total: z
				.number()
				.int()
				.describe(
					'All memberless team organizations matching the request, before limit.',
				),
			orgs: z.array(
				z.object({
					org_id: z.string(),
					slug: z.string(),
					created_at: z.string(),
					creator_deleted: z
						.boolean()
						.describe("True when the creating person's account is gone."),
					package_count: z.number().int().nonnegative(),
				}),
			),
			purged_org_ids: z.array(z.string()),
			failures: z.array(z.object({ org_id: z.string(), error: z.string() })),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminMemberlessTeamOrgsCleanup',
				async () => {
					const actor = await resolveActingAdminPerson(ctx)
					const result = await cleanupMemberlessTeamOrgs({
						env: ctx.env,
						dryRun: args.dryRun,
						limit: args.limit,
						orgIds: args.org_ids,
						actorUserId: actor.stableUserId,
						actorUsername: actor.username,
					})
					return {
						dryRun: result.dryRun,
						total: result.total,
						orgs: result.orgs.map((org) => ({
							org_id: org.orgId,
							slug: org.slug,
							created_at: org.createdAt,
							creator_deleted: org.creatorDeleted,
							package_count: org.packageCount,
						})),
						purged_org_ids: result.purgedOrgIds,
						failures: result.failures.map((failure) => ({
							org_id: failure.orgId,
							error: failure.error,
						})),
					}
				},
				{
					successReason: (result) =>
						`dryRun=${result.dryRun ? 1 : 0};total=${result.total};purged=${result.purged_org_ids.length};failed=${result.failures.length}`,
				},
			)
		},
	},
)

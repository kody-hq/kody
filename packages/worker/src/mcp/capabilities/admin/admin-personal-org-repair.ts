import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	personalOrgRepairLimitDefault,
	personalOrgRepairLimitMax,
	runPersonalOrgRepair,
} from '#worker/admin/personal-org-repair.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), count accounts missing personal org rows without writing. Set false to repair.',
		),
	stableUserId: stableUserIdSchema
		.optional()
		.describe('Limit the scan to one account.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(personalOrgRepairLimitMax)
		.optional()
		.describe(
			`Users to inspect this page (1-${personalOrgRepairLimitMax}, default ${personalOrgRepairLimitDefault}).`,
		),
	cursor: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			'Resume after this users.id. Keep paging until nextCursor is null.',
		),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	counts: z.object({
		scanned: count,
		distinctOrgId: count.describe(
			'Scanned accounts whose personal org id differs from the person id (signups since #3053 phase 2).',
		),
		missingOrg: count,
		missingMembership: count,
		missingHandle: count,
		needsRepair: count,
		repaired: count.describe('Repaired (or that would be repaired on dryRun).'),
		skippedOrgSoftDeleted: count,
		skippedSlugTaken: count,
		failed: count,
	}),
	bySignupPath: z.array(z.object({ signupPath: z.string(), count })),
	outcomes: z.array(
		z.object({
			stableUserId: z.string(),
			outcome: z.enum([
				'repaired',
				'skipped_org_soft_deleted',
				'skipped_slug_taken',
				'failed',
			]),
			error: z.string().optional(),
		}),
	),
	nextCursor: z.number().int().nullable(),
})

export const adminPersonalOrgRepairCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminPersonalOrgRepair',
		contextRuns: 'deny',
		description:
			'Find live accounts whose personal org (users.personal_org_id) is missing its live orgs row, owner membership, or handle, grouped by signup path. dryRun defaults to true. With dryRun false, recreates only the missing rows (free plan defaults; never changes plan, credits, or enablements) and audits each repaired account. Skips soft-deleted orgs and taken slugs. Idempotent; page with cursor until nextCursor is null.',
		keywords: ['admin', 'personal org', 'org', 'repair', 'backfill', 'missing'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPersonalOrgRepair',
				async () =>
					await runPersonalOrgRepair({
						env: ctx.env,
						dryRun,
						actorEmail: ctx.callerContext.user?.email ?? null,
						stableUserId: args.stableUserId,
						limit: args.limit,
						cursor: args.cursor ?? null,
					}),
				{
					resultOf: (r) => (r.counts.failed > 0 ? 'failure' : 'success'),
					successReason: (r) =>
						`dry_run=${r.dryRun};scanned=${r.counts.scanned};needs_repair=${r.counts.needsRepair};repaired=${r.counts.repaired};failed=${r.counts.failed}`,
				},
			)
		},
	},
)

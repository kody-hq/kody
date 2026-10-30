import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	creatorAccessBackfillLimitDefault,
	creatorAccessBackfillLimitMax,
	creatorAccessBackfillOutcomes,
	runCreatorAccessBackfill,
} from '#worker/orgs/creator-access-backfill.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report what would be granted without writing. Set false to write the creator grants.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Resume after this org id from a prior nextCursor.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(creatorAccessBackfillLimitMax)
		.optional()
		.describe(
			`Orgs to scan this step (default ${creatorAccessBackfillLimitDefault}, max ${creatorAccessBackfillLimitMax}).`,
		),
	orgIds: z.array(z.string().min(1)).min(1).max(100).optional(),
})

const count = z.number().int().nonnegative()

const outputSchema = z.object({
	dryRun: z.boolean(),
	orgsScanned: count,
	...(Object.fromEntries(
		creatorAccessBackfillOutcomes.map((outcome) => [outcome, count]),
	) as Record<(typeof creatorAccessBackfillOutcomes)[number], typeof count>),
	nextCursor: z.string().nullable(),
	details: z.array(
		z.object({
			orgId: z.string(),
			resourceType: z.enum(['package', 'app', 'credential']),
			resourceId: z.string(),
			creatorUserId: z.string(),
			outcome: z.enum(creatorAccessBackfillOutcomes),
		}),
	),
})

export const adminCreatorAccessBackfillCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: false,
		idempotent: true,
		name: 'adminCreatorAccessBackfill',
		contextRuns: 'deny',
		description:
			"Creator grants for packages, package apps, and team credentials that non-owner members created before creators got a grant on create. The creator is the actor of the first-publish (`package.published` firstPublish) or `credential.created` audit row. Skips owners, ex-members, deleted resources, and anyone whose grant on the resource exists or was ever revoked. dryRun (default true) writes nothing. Both modes return counts plus per-resource details (org, resource, and creator ids); apply writes `manage` grants with origin 'created'. Idempotent. Internal admin output: share counts only, not the details. One page of orgs per execute; resume with nextCursor until null.",
		keywords: [
			'admin',
			'creator',
			'grant',
			'backfill',
			'package',
			'credential',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreatorAccessBackfill',
				async () =>
					await runCreatorAccessBackfill({
						env: ctx.env,
						audit: dryRun
							? null
							: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
						dryRun,
						afterOrgId: args.cursor ?? null,
						limit: args.limit,
						orgIds: args.orgIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};orgs=${result.orgsScanned};would_grant=${result.would_grant};granted=${result.granted};already=${result.already_granted};revoked=${result.previously_revoked}`,
				},
			)
		},
	},
)

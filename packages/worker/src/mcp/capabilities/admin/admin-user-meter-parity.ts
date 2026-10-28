import { z } from 'zod'
import { loadAdminUserMeterParityReport } from '#worker/admin/user-meter-parity.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { dailyEntitlementResources } from '#universal/plans.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const dailyResourceSchema = z.enum(dailyEntitlementResources)

const dailyResourceReadSchema = z.object({
	resource: dailyResourceSchema,
	meterCount: z.number().int().nonnegative().nullable(),
	needsBootstrap: z.boolean(),
})

const storageParitySchema = z.object({
	d1Bytes: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Physical recompute from D1 payload tables (the reconcile-lane source), not a stored mirror.',
		),
	meterBytes: z.number().int().nonnegative().nullable(),
	needsBootstrap: z.boolean(),
	delta: z.number().int().nullable(),
	parity: z.boolean(),
})

const deletionParitySchema = z.object({
	d1DeletingAt: z.string().nullable(),
	meterDeletingAt: z.string().nullable(),
	deletingAtParity: z
		.boolean()
		.describe(
			'True when D1 users.deleting_at matches the UserMeter tombstone.',
		),
	activeLeaseCount: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Count of active write leases in the authoritative UserMeter Durable Object.',
		),
})

const reportSchema = z.object({
	generatedAt: z.string(),
	stableUserId: stableUserIdSchema,
	daily: z
		.object({
			day: z.string(),
			resources: z.array(dailyResourceReadSchema),
		})
		.describe(
			'UserMeter-only daily counter reads. There is no D1 entitlement_daily_counters mirror, so no D1 comparison exists.',
		),
	storage: storageParitySchema,
	deletion: deletionParitySchema,
})

const inputSchema = z.object({
	stable_user_id: stableUserIdSchema,
})

const outputSchema = z.object({
	report: reportSchema.nullable(),
})

export const adminUserMeterParityCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminUserMeterParity',
		contextRuns: 'deny',
		description:
			'Read-only production verification report for one owner id (person `users.stable_user_id` or team `orgs.id`): UserMeter daily counter reads (meter-only; there is no D1 entitlement_daily_counters table), physical D1 payload recompute versus authoritative UserMeter storage bytes, and deletion-fence verification. Deletion reports `deletingAtParity` (D1 permanent tombstone versus meter fence) and `activeLeaseCount` (active authoritative UserMeter write leases). Never bootstraps or writes parity state; returns counts and parity only (no lease tokens/holders or email content). Admin-only.',
		keywords: [
			'admin',
			'user meter',
			'parity',
			'daily counters',
			'storage bytes',
			'write leases',
			'deletion',
			'bootstrap',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserMeterParity',
				async () => ({
					report: await loadAdminUserMeterParityReport({
						db: ctx.env.APP_DB,
						env: ctx.env,
						jobs: jobsData(ctx.env),
						stableUserId: args.stable_user_id,
					}),
				}),
				{
					successReason: () => `target_stable_user_id=${args.stable_user_id}`,
				},
			)
		},
	},
)

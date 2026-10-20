import { z } from 'zod'
import {
	adminFleetErrorRateDefaultDays,
	adminFleetErrorRateMaxDays,
	loadAdminFleetErrorRateData,
} from '#worker/admin/fleet-error-rate-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const countsSchema = z.object({
	events: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
	rate: z.number().nullable(),
})

const metricRowSchema = countsSchema.extend({
	metric: z.enum([
		'package_export',
		'package_static_call',
		'job_run',
		'workflow_run',
	]),
})

const windowSchema = z.object({
	start: z.string(),
	end: z.string(),
	combined: countsSchema,
	by_metric: z.array(metricRowSchema),
})

const comparisonSchema = z.object({
	kind: z.enum(['hour', 'day']),
	recent: windowSchema,
	previous: windowSchema,
})

const concentrationSchema = z
	.object({
		kind: z.enum(['one_account', 'few_accounts', 'fleet']),
		recent_errors: z.number().int().nonnegative(),
		owner_count: z.number().int().nonnegative(),
		package_count: z.number().int().nonnegative(),
		top_owner_share: z.number().nonnegative(),
		owners: z.array(
			z.object({
				username: z.string(),
				error_share: z.number().nonnegative(),
				packages: z.array(z.object({ kody_id: z.string() })),
			}),
		),
	})
	.nullable()

const snapshotSchema = z.object({
	available: z.boolean(),
	updatedAt: z.string().nullable(),
	environment: z.string().nullable(),
	day: comparisonSchema.nullable(),
	hour: comparisonSchema.nullable(),
	lastAlertAt: z.string().nullable(),
	concentration: concentrationSchema,
})

const dailyRowSchema = z.object({
	day: z.string().describe('UTC calendar day (YYYY-MM-DD).'),
	errorCount: z
		.number()
		.int()
		.nonnegative()
		.describe('Fleet package-runtime events with outcome error.'),
	caughtCount: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'package_static_call throws rewritten to caught when the run succeeded.',
		),
	usersWithErrors: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Fleet: distinct Analytics Engine billing owner ids (blob1) with at least one error that day (not person-deduped across legacy person vs personal-org ids). Filtered: 0 or 1 for that account. Aggregate only — no handles.',
		),
})

const inputSchema = z.object({
	days: z
		.number()
		.int()
		.min(1)
		.max(adminFleetErrorRateMaxDays)
		.default(adminFleetErrorRateDefaultDays)
		.describe(
			`UTC calendar days to include in the daily breakdown, ending today (default ${adminFleetErrorRateDefaultDays}, max ${adminFleetErrorRateMaxDays}).`,
		),
	stableUserId: stableUserIdSchema
		.optional()
		.describe(
			'Optional person filter. When set, daily rows are that account only (personal org + legacy person billing ids). Still aggregates — no username.',
		),
})

const outputSchema = z.object({
	snapshot: snapshotSchema.describe(
		'Same fleet package error-rate snapshot as /admin/insights (hour and day windows, optional concentration).',
	),
	days: z.number().int().positive(),
	startDay: z.string(),
	endDay: z.string(),
	dailyAvailable: z
		.boolean()
		.describe(
			'False when Analytics Engine credentials are missing, local/dev, or the daily query failed.',
		),
	daily: z.array(dailyRowSchema),
	filter: z
		.object({ stableUserId: stableUserIdSchema })
		.nullable()
		.describe(
			'Echo of stableUserId when filtering; null for fleet aggregates.',
		),
})

export const adminFleetErrorRateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminFleetErrorRate',
		description:
			'Read-only fleet package-runtime error-rate health: the same hour/day KV snapshot as /admin/insights, plus a daily caught vs error breakdown (default 7 days, max 31) with distinct users-with-errors counts. Optional stableUserId scopes daily rows to one account. Admin-only; daily aggregates never list handles. Concentration usernames appear only when the shared snapshot is elevated (same as the page).',
		keywords: [
			'admin',
			'fleet',
			'error rate',
			'caught',
			'insights',
			'package runtime',
			'health',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFleetErrorRate',
				() =>
					loadAdminFleetErrorRateData({
						env: ctx.env,
						days: args.days,
						stableUserId: args.stableUserId,
					}),
				{
					successReason: (result) =>
						[
							`days=${result.days}`,
							`daily_available=${result.dailyAvailable}`,
							`snapshot_available=${result.snapshot.available}`,
							result.filter ? `filter=stable_user_id` : 'filter=fleet',
						].join(';'),
				},
			)
		},
	},
)

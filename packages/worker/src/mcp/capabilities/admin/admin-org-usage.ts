import { z } from 'zod'
import { planNames } from '#universal/plans.ts'
import { loadAdminOrgUsageData } from '#worker/admin/org-usage-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { adminOrgTargetSchema } from './org-limit-override-shared.ts'

const usageMetricSchema = z.enum([
	'execute',
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
	'outbound_fetch',
	'email_send',
	'email_received',
	'dynamic_worker_day',
	'dynamic_worker_cpu',
	'durable_object_gb_seconds',
	'durable_object_rows_read',
	'durable_object_platform_rows_read',
])

const entitlementResourceSchema = z.enum([
	'saved_packages',
	'scheduled_jobs',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'storage_bytes',
	'execute_unique_workers_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
])

const planSchema = z.enum(planNames)

const usageRollupSchema = z.object({
	metric: usageMetricSchema,
	eventCount: z.number().int().nonnegative(),
	errorCount: z.number().int().nonnegative(),
	caughtCount: z.number().int().nonnegative(),
	totalDurationMs: z.number().int().nonnegative(),
	totalCpuMs: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
})

const entitlementConsumptionSchema = z.object({
	resource: entitlementResourceSchema,
	label: z.string(),
	current: z.number().int().nonnegative(),
	limit: z.number().int().nonnegative(),
	percentOfLimit: z.number().nonnegative().nullable(),
	overEightyPercent: z.boolean(),
})

const outputSchema = z.object({
	usage: z
		.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				displayName: z.string().nullable(),
			}),
			plan: planSchema,
			currentMonth: z.string(),
			today: z.string(),
			currentMonthUsage: z.array(usageRollupSchema),
			monthUsage: z.array(
				z.object({
					month: z.string(),
					usage: z.array(usageRollupSchema),
				}),
			),
			entitlementConsumption: z.array(entitlementConsumptionSchema),
			warnings: z.array(entitlementConsumptionSchema),
			dynamicWorkerCost: z.object({
				uniqueWorkerDays: z.number().int().nonnegative(),
				estimatedGrossUsd: z.number().nonnegative(),
				usdPerUniqueDay: z.number().nonnegative(),
				includedPerAccountMonth: z.number().int().nonnegative(),
			}),
			costVsPay: z.object({
				uniqueWorkerDays: z.number().int().nonnegative(),
				estimatedGrossUsd: z.number().nonnegative(),
				usdPerUniqueDay: z.number().nonnegative(),
				includedPerAccountMonth: z.number().int().nonnegative(),
				estimatedPaidUsdCents: z.number().int().nonnegative(),
				estimatedMarginUsd: z.number(),
				underwater: z.boolean(),
				paidSource: z.enum(['stripe_catalog', 'none']),
				risk: z.enum([
					'none',
					'paid_underwater',
					'free_near_allotment',
					'missing_price_id',
				]),
			}),
			durableObjectDuration: z.object({
				gbSeconds: z.number().nonnegative(),
				durationMs: z.number().nonnegative(),
				rpcCount: z.number().int().nonnegative(),
				memoryGb: z.number().nonnegative(),
				measured: z.object({
					activeMs: z.number().nonnegative(),
					gbSeconds: z.number().nonnegative(),
					estimatedUsd: z.number().nonnegative(),
					lastDay: z.string().nullable(),
					byClass: z.array(
						z.object({
							doClass: z.string(),
							activeMs: z.number().nonnegative(),
							gbSeconds: z.number().nonnegative(),
						}),
					),
				}),
			}),
		})
		.nullable(),
})

export const adminOrgUsageCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminOrgUsage',
		description:
			'Read usage rollups, entitlement counters, plan-limit consumption, estimated Cloudflare Dynamic Worker cost vs catalog list MRR, and observe-only Durable Object duration (GB-s) for one org by org id or slug. Works for personal and team orgs. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'usage',
			'quotas',
			'entitlements',
			'plans',
			'metering',
			'cost',
			'org',
			'team',
		],
		inputSchema: adminOrgTargetSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(ctx, 'adminOrgUsage', async () => {
				const data = await loadAdminOrgUsageData(ctx.env, {
					orgId: args.orgId,
					org: args.org,
				})
				if (!data) return { usage: null }
				const { ok: _ok, ...usage } = data
				return { usage }
			})
		},
	},
)

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	attributionLogReportDaysMax,
	readAttributionLogReport,
} from '#worker/credentials/attribution-log-report.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()
const group = { kind: z.string(), surface: z.string(), pattern: z.string() }

const inputSchema = z.object({
	days: z
		.number()
		.int()
		.min(1)
		.max(attributionLogReportDaysMax)
		.optional()
		.describe(
			`UTC days to include, counting today (default 2, max ${attributionLogReportDaysMax}).`,
		),
	packageIds: z
		.array(z.string().min(1))
		.max(20)
		.optional()
		.describe(
			'Only rows whose run package or bound package is one of these saved package ids.',
		),
})

const outputSchema = z.object({
	sinceDay: z.string(),
	totals: z.array(
		z.object({
			...group,
			rows: count,
			observations: count,
			owners: count,
			credentials: count,
		}),
	),
	packages: z
		.array(
			z.object({
				...group,
				runPackageId: z.string(),
				boundPackageId: z.string(),
				changedIntrinsics: z.string(),
				observations: count,
				owners: count,
				credentials: count,
				firstSeenAt: z.string(),
				lastSeenAt: z.string(),
			}),
		)
		.describe('Largest groups first, capped.'),
	packagesTruncated: z.boolean(),
})

export const adminCredentialAttributionLogReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminCredentialAttributionLogReport',
		contextRuns: 'deny',
		description:
			'Read-only counts from the credential attribution log: refusals of a credential with an allowed packages list that was asked for outside a listed package (kinds ad_hoc, run_package_unbound, listed_package_unbound) and allowed uses in a run whose shared globals were replaced (intrinsics_changed). Totals by kind, surface and pattern, then the same by run package and bound package id with first and last seen times. Package ids, kinds and counts only: no credential names, owner ids or values. Writes nothing.',
		keywords: ['admin', 'credential', 'allowed packages', 'refusal', 'log'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialAttributionLogReport',
				async () =>
					await readAttributionLogReport({
						db: ctx.env.APP_DB,
						days: args.days ?? 2,
						packageIds: args.packageIds,
					}),
				{
					successReason: (result) =>
						`groups=${result.totals.length};packages=${result.packages.length}`,
				},
			)
		},
	})

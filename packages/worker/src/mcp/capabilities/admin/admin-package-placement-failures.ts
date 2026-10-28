import { z } from 'zod'
import { loadPackagePlacementFailures } from '#worker/admin/package-placement-failures.ts'
import { packageFailureSummaryMaxPackageIds } from '#worker/run-records/package-failure-summary.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const isoTimestampSchema = z.iso.datetime({ offset: true })

const inputSchema = z.object({
	since: isoTimestampSchema.describe(
		'Inclusive start of the window (ISO 8601), compared with run started_at.',
	),
	until: isoTimestampSchema.describe(
		'Exclusive end of the window (ISO 8601). At most 31 days after since.',
	),
	packageIds: z
		.array(z.string().trim().min(1))
		.max(packageFailureSummaryMaxPackageIds)
		.optional()
		.describe(
			'Saved package ids to flag: every failed run of a flagged package in the window is counted, whatever the error.',
		),
	flaggedByCodemodRun: z
		.object({
			runId: z.string().trim().min(1).describe('Package codemod run id.'),
			finding: z
				.string()
				.trim()
				.min(1)
				.describe(
					'Finding label the run item must carry, for example "secret outside header".',
				),
		})
		.optional()
		.describe(
			'Also flag every package whose item in this codemod run has the finding.',
		),
})

const countsSchema = z.object({
	count: z.number().int().nonnegative(),
	firstAt: z.string().nullable().describe('Earliest run started_at.'),
	lastAt: z.string().nullable().describe('Latest run started_at.'),
})

const outputSchema = z.object({
	since: z.string(),
	until: z.string(),
	flaggedPackageCount: z.number().int().nonnegative(),
	ownersAttempted: z.number().int().nonnegative(),
	ownersLoaded: z.number().int().nonnegative(),
	complete: z
		.boolean()
		.describe(
			'False when an owner RunLog read failed, the owner list hit its cap, or one owner had more flagged packages than a single RunLog summary accepts.',
		),
	packages: z.array(
		z.object({
			ownerId: z.string(),
			ownerHandle: z.string().nullable(),
			packageId: z
				.string()
				.nullable()
				.describe('Null for the owner runs that carry no package.'),
			kodyId: z.string().nullable(),
			flagged: z.boolean(),
			placementRefusals: countsSchema.describe(
				'Failed runs whose error is a header-only placement refusal.',
			),
			failedRuns: countsSchema
				.nullable()
				.describe('Every failed run in the window. Null unless flagged.'),
		}),
	),
})

export const adminPackagePlacementFailuresCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPackagePlacementFailures',
		contextRuns: 'deny',
		description:
			'Read-only content-free fleet read of failed package runs in a time window. Per package: owner handle, package id and kody id, the count and first/last started_at of failed runs whose error was a header-only secret placement refusal (the rule that filled secrets only in request headers), and, for flagged packages (packageIds or a codemod run finding), the count and first/last started_at of every failed run. Fans out one RunLog read per package owner. Admin-only; never returns run inputs, outputs, logs, error messages, or secrets, and sends nothing.',
		keywords: [
			'admin',
			'run log',
			'failed runs',
			'placement refusal',
			'secret placeholder',
			'header',
			'credential',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPackagePlacementFailures',
				() => loadPackagePlacementFailures({ env: ctx.env, window: args }),
				{
					successReason: (result) =>
						`since=${result.since} until=${result.until} packages=${result.packages.length} complete=${result.complete}`,
				},
			)
		},
	},
)

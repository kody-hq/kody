import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { declarePackageAppCapabilitiesCodemodId } from '#worker/package-codemods/codemods/0018-declare-package-app-capabilities.ts'
import { buildPackageAppCapabilityMigrationReport } from '#worker/package-codemods/package-app-capability-migration-report.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.describe(
			`Run id of a ${declarePackageAppCapabilitiesCodemodId} dry run or apply. Scan runs only detect and record nothing to add, so they are refused.`,
		),
	packageId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"One app's private list of capabilities the run would add, for that app's owner only.",
		),
})

const outputSchema = z.object({
	runId: z.string(),
	codemodId: z.string(),
	mode: z.string(),
	status: z.string(),
	items: z.object({ total: count, byStatus: z.record(z.string(), count) }),
	appsAffected: count.describe('Apps the run adds at least one capability to.'),
	ownersAffected: count,
	capabilitiesAdded: z.object({
		total: count,
		byCapability: z
			.record(z.string(), count)
			.describe('Apps per added platform capability name.'),
	}),
	unresolvedApps: z
		.object({
			count,
			apps: z.array(
				z.object({
					packageId: z.string(),
					computedCalls: count,
					mcpCalls: count,
					unresolvedImports: count,
					unknownCapabilityNames: count,
					credentialNamedCalls: count,
				}),
			),
		})
		.describe(
			'Apps with calls the static scan cannot resolve even after gap filling from the runtime logs. Counts and package ids only.',
		),
	app: z
		.object({ packageId: z.string(), addedCapabilities: z.array(z.string()) })
		.nullable()
		.describe(
			'Only with packageId: that app’s private list. Show it to its owner only; never paste it into public text.',
		),
})

export const adminPackageAppCapabilityMigrationReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminPackageAppCapabilityMigrationReport',
		contextRuns: 'deny',
		description: `Read-only counts for a ${declarePackageAppCapabilitiesCodemodId} codemod run: apps and owners affected, capabilities added (total and per platform capability), and apps with calls that cannot be resolved statically. Pass packageId for one app's private list of added capabilities. Admin-only.`,
		keywords: [
			'admin',
			'package app',
			'capabilities',
			'codemod',
			'migration',
			'dry run',
			'declare capabilities',
		],
		tags: ['codemod'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageAppCapabilityMigrationReport',
				async () => {
					const report = await buildPackageAppCapabilityMigrationReport({
						db: ctx.env.APP_DB,
						runId: args.runId,
						packageId: args.packageId,
					})
					if (!report) {
						throw new Error(
							`No ${declarePackageAppCapabilitiesCodemodId} dry run or apply with that id.`,
						)
					}
					return report
				},
				{
					successReason: (result) =>
						`run=${result.runId};apps=${String(result.appsAffected)};owners=${String(result.ownersAffected)};added=${String(result.capabilitiesAdded.total)};unresolved=${String(result.unresolvedApps.count)}`,
				},
			)
		},
	})

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { runCredentialBackfill } from '#worker/credentials/credential-inventory.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.describe('A complete adminCredentialInventoryScan run.'),
	dryRun: z
		.boolean()
		.optional()
		.describe('When true (default), count the writes without making them.'),
	acknowledgedFailedPackageIds: z
		.array(z.string().min(1))
		.optional()
		.describe(
			'Package ids the run failed to scan that you accept may use credentials the run never saw. An apply with failed packages proceeds only when this lists exactly those packages (see the scan report failures).',
		),
})

const outputSchema = z.object({
	runId: z.string(),
	dryRun: z.boolean(),
	counts: z.object({
		failedPackages: count.describe(
			'Packages the run could not scan. An apply refuses while any remain unless acknowledgedFailedPackageIds lists exactly those packages.',
		),
		credentials: count.describe('Credential ids the run attributed usage to.'),
		missingRows: count,
		provider: z.object({
			write: count,
			alreadySet: count,
			none: count,
			conflicting: count,
			invalid: count,
		}),
		inject: z.object({
			write: count,
			header: count,
			query: count,
			alreadySet: count,
			default: count,
			mixed: count,
			unsupported: count,
			unused: count,
		}),
	}),
	writtenRows: count,
})

export const adminCredentialBackfillCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminCredentialBackfill',
		contextRuns: 'deny',
		description:
			'Fill credential `provider` and `inject` from a complete inventory run (ADR 0068). provider is written only when every slot naming the credential agrees on one provider slug; inject only when every placement is the same header or the same query param. Only unset columns are written, and nothing reads them yet. An apply refuses a run with failed packages (counts.failedPackages) unless acknowledgedFailedPackageIds lists exactly those packages. Never reads a credential value. dryRun defaults to true.',
		keywords: [
			'admin',
			'credential',
			'backfill',
			'provider',
			'inject',
			'inventory',
			'secret',
			'integration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialBackfill',
				async () =>
					await runCredentialBackfill({
						env: ctx.env,
						runId: args.runId,
						dryRun: args.dryRun !== false,
						acknowledgedFailedPackageIds: args.acknowledgedFailedPackageIds,
					}),
				{
					successReason: (result) =>
						`run=${result.runId};dry_run=${result.dryRun};acknowledged_failed=${result.dryRun ? 0 : result.counts.failedPackages};provider=${result.counts.provider.write};inject=${result.counts.inject.write};written=${result.writtenRows}`,
				},
			)
		},
	},
)

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	packageCodemodHeavyPagingHint,
	packageCodemodStepResultSchema,
	runFleetPackageCodemodStep,
} from '#mcp/capabilities/packages/package-codemod-shared.ts'
import { credentialStampConvertCodemodId } from '#worker/credentials/credential-stamp-convert.ts'
import { credentialStampMigrateHoldouts } from '#worker/credentials/credential-stamp-migrate-holdouts.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const holdoutList = credentialStampMigrateHoldouts
	.map((name) => `\`${name}\``)
	.join(', ')

const pagingHint = `One page per execute/sandbox. Resume with the returned runId and nextCursor until null. dryRun default is true (transform + publish checks only); set dryRun false to republish converted trees. Codemod ${credentialStampConvertCodemodId} skips Kent holdouts (${holdoutList}) and anything still unconvertible; it never emails or notifies package owners, never creates credential values, and preserves job/trigger enablements via the existing republish path. After apply pages complete, run adminCredentialStampBackfill dryRun→false to stamp seal-ready packages. ${packageCodemodHeavyPagingHint}`

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), dry-run the conversion codemod without writing. Set false to apply: republish converted published trees that stay seal-ready after transform + checks.',
		),
	packageIds: z
		.array(z.string().min(1))
		.min(1)
		.max(90)
		.optional()
		.describe('Optional canary: only these saved package ids.'),
	runId: z
		.string()
		.min(1)
		.optional()
		.describe('Existing run id to continue; required with cursor when paging.'),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous nextCursor value.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe(
			'Max packages this step (default 5, max 10). One page per execute/sandbox.',
		),
	filters: z
		.object({
			userIds: z.array(z.string().min(1)).min(1).max(90).optional(),
			packageIds: z.array(z.string().min(1)).min(1).max(90).optional(),
		})
		.optional()
		.describe('Optional fleet filters for canary or partial runs.'),
})

export const adminCredentialStampMigrateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminCredentialStampMigrate',
		contextRuns: 'deny',
		description: `Platform-side credential-stamp migration for issue #3836: fleet dry-run/apply of ${credentialStampConvertCodemodId} (declare allowlisted missing bare deps such as remix, seal inferred kody.credentials). Does not strip |scope= placeholders. Skips Kent holdouts and packages that cannot be proven conversion-ready. No owner contact. Does not enable phase 3 runtime fail-closed. ${pagingHint}`,
		keywords: [
			'admin',
			'credential',
			'stamp',
			'credentials',
			'migrate',
			'conversion',
			'fleet',
			'3836',
			'codemod',
			'0015',
		],
		tags: ['codemod', 'credentials'],
		inputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			const packageIds = args.packageIds ?? args.filters?.packageIds
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialStampMigrate',
				async () =>
					await runFleetPackageCodemodStep(ctx, {
						codemodId: credentialStampConvertCodemodId,
						mode: dryRun ? 'dry-run' : 'apply',
						packageIds,
						filters: args.filters,
						runId: args.runId,
						cursor: args.cursor,
						limit: args.limit,
					}),
				{
					successReason: (result) =>
						`dry_run=${dryRun};codemod=${result.codemodId};run=${result.runId};mode=${result.mode}`,
				},
			)
		},
	},
)

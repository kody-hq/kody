import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteStaleFeatureFlagWithAudit } from '#worker/feature-flags/delete-stale.ts'
import {
	countStaleFeatureFlagRows,
	listFeatureFlagsForAdmin,
	totalStaleFeatureFlagRows,
} from '#worker/feature-flags/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import { adminFeatureFlagSchema } from './feature-flag-shared.ts'

const inputSchema = z.object({
	key: z
		.string()
		.trim()
		.min(1)
		.describe(
			'Stale feature flag key (listed with stale: true by adminFeatureFlagList). Registry keys are refused.',
		),
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true, report the rows that would be deleted and keep them.',
		),
})

const rowCountsSchema = z.object({
	global: z.number().int().min(0),
	userOverrides: z.number().int().min(0),
	orgOverrides: z.number().int().min(0),
	repoOverrides: z.number().int().min(0),
})

const outputSchema = z.object({
	key: z.string(),
	dryRun: z.boolean(),
	deleted: rowCountsSchema.describe(
		'Rows removed per table, or the rows that would be removed on a dry run.',
	),
	flag: adminFeatureFlagSchema
		.nullable()
		.describe(
			'The flag as adminFeatureFlagList showed it before the delete (global row, user and org overrides).',
		),
})

export const adminFeatureFlagDeleteStaleCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminFeatureFlagDeleteStale',
		contextRuns: 'deny',
		description:
			'Delete a stale feature flag (a key no longer in the code registry): its global row plus every user, org, and repo override. Same path and `feature_flag_delete_stale` audit entry as the Delete button at /admin/feature-flags. Pass dryRun: true to preview. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'stale',
			'delete',
			'cleanup',
			'remove',
			'overrides',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const dryRun = args.dryRun === true
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagDeleteStale',
				async () => {
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					const flag = flags.find((entry) => entry.key === args.key) ?? null
					const deleted = dryRun
						? await countStaleFeatureFlagRows(ctx.env.APP_DB, args.key)
						: await deleteStaleFeatureFlagWithAudit({
								env: ctx.env,
								key: args.key,
								actorEmail: (await resolveActingAdminPerson(ctx)).email,
								path: '/mcp',
							})
					if (!deleted || totalStaleFeatureFlagRows(deleted) === 0) {
						throw new McpCallerError(
							`Stale feature flag "${args.key}" not found.`,
						)
					}
					return { key: args.key, dryRun, deleted, flag }
				},
				{
					// A real delete records `feature_flag_delete_stale` itself.
					skipSuccessAudit: () => !dryRun,
					successReason: ({ key }) => `dry_run;key=${key}`,
				},
			)
		},
	},
)

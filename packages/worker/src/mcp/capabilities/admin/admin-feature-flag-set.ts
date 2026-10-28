import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
} from '#worker/feature-flags/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminUserId,
} from './admin-shared.ts'
import {
	adminFeatureFlagSchema,
	assertFeatureFlagKey,
} from './feature-flag-shared.ts'

const inputSchema = z.object({
	key: z.string().min(1).describe('Feature flag key from the code registry.'),
	enabled: z.boolean().describe('Whether the flag is globally enabled.'),
	rolloutPercent: z
		.number()
		.int()
		.min(0)
		.max(100)
		.nullable()
		.optional()
		.describe(
			'Optional 0–100 percentage rollout when enabled. Null or omitted means 100% of users once enabled.',
		),
	audience: z
		.enum(['everyone', 'experiments_opt_in'])
		.optional()
		.describe(
			'Who the flag may turn on for after global/rollout evaluation. `everyone` (default) is unrestricted. `experiments_opt_in` limits to users who opted in at /account/experiments. Per-user overrides still win. Omit to leave the stored audience unchanged.',
		),
	note: z
		.string()
		.optional()
		.describe('Optional operator note stored with the global flag state.'),
})

const outputSchema = z.object({
	flag: adminFeatureFlagSchema,
})

export const adminFeatureFlagSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminFeatureFlagSet',
		contextRuns: 'deny',
		description:
			'Set global enabled state and optional percentage rollout for one registry feature flag. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'rollout',
			'toggle',
			'enable',
			'disable',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagSet',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const updatedBy = await resolveActingAdminUserId(ctx)
					await setFeatureFlagGlobalState(ctx.env.APP_DB, {
						key,
						enabled: args.enabled,
						rolloutPercent:
							args.rolloutPercent === undefined ? null : args.rolloutPercent,
						...(args.audience === undefined ? {} : { audience: args.audience }),
						note: args.note,
						updatedBy,
					})
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					const flag = flags.find((entry) => entry.key === key)
					if (!flag) {
						throw new Error(`Feature flag "${key}" was not found after update.`)
					}
					return { flag }
				},
				{
					successReason: ({ flag }) =>
						`key=${flag.key};enabled=${flag.global?.enabled ?? false};rollout=${flag.global?.rolloutPercent ?? 'null'};audience=${flag.global?.audience ?? 'everyone'}`,
				},
			)
		},
	},
)

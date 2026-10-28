import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	clearFeatureFlagUserOverride,
	listFeatureFlagsForAdmin,
	setFeatureFlagUserOverride,
} from '#worker/feature-flags/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminUserId,
	stableUserIdSchema,
} from './admin-shared.ts'
import {
	adminFeatureFlagSchema,
	assertFeatureFlagKey,
	resolveTargetUser,
} from './feature-flag-shared.ts'

const inputSchema = z
	.object({
		key: z.string().min(1).describe('Feature flag key from the code registry.'),
		stableUserId: stableUserIdSchema.optional(),
		username: z
			.string()
			.optional()
			.describe(
				'Username for the override target when stableUserId is omitted.',
			),
		enabled: z
			.boolean()
			.optional()
			.describe('Override enabled state. Required unless clear is true.'),
		clear: z
			.boolean()
			.optional()
			.describe(
				'When true, remove the per-user override instead of setting it.',
			),
	})
	.superRefine((value, context) => {
		const clear = value.clear === true
		if (clear && value.enabled !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Do not provide enabled when clear is true.',
				path: ['enabled'],
			})
		}
		if (!clear && value.enabled === undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Provide enabled when setting an override, or clear: true.',
				path: ['enabled'],
			})
		}
		if (value.stableUserId === undefined && value.username === undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Provide either stableUserId or username.',
				path: ['stableUserId'],
			})
		}
		if (value.stableUserId !== undefined && value.username !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Provide either stableUserId or username, not both.',
				path: ['username'],
			})
		}
	})

const outputSchema = z.object({
	flag: adminFeatureFlagSchema,
	cleared: z.boolean(),
})

export const adminFeatureFlagOverrideCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminFeatureFlagOverride',
		contextRuns: 'deny',
		description:
			'Set or clear a per-user feature flag override by stable user id or username. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'override',
			'per-user',
			'toggle',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagOverride',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const target = await resolveTargetUser(ctx.env.APP_DB, {
						stableUserId: args.stableUserId,
						username: args.username,
					})
					const clear = args.clear === true
					if (clear) {
						const cleared = await clearFeatureFlagUserOverride(ctx.env.APP_DB, {
							key,
							userId: target.dbUserId,
						})
						if (!cleared) {
							throw new McpCallerError(
								`No override exists for feature flag "${key}" and stableUserId ${target.stableUserId}.`,
							)
						}
					} else {
						const updatedBy = await resolveActingAdminUserId(ctx)
						await setFeatureFlagUserOverride(ctx.env.APP_DB, {
							key,
							userId: target.dbUserId,
							enabled: args.enabled === true,
							updatedBy,
						})
					}
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					const flag = flags.find((entry) => entry.key === key)
					if (!flag) {
						throw new Error(`Feature flag "${key}" was not found after update.`)
					}
					return { flag, cleared: clear }
				},
				{
					successReason: ({ flag, cleared }) =>
						`key=${flag.key};cleared=${cleared};overrides=${flag.overrides.length}`,
				},
			)
		},
	},
)

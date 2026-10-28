import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	clearFeatureFlagOrgOverride,
	listFeatureFlagsForAdmin,
	setFeatureFlagOrgOverride,
} from '#worker/feature-flags/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import {
	adminFeatureFlagSchema,
	assertFeatureFlagKey,
	resolveTargetOrg,
} from './feature-flag-shared.ts'

const inputSchema = z
	.object({
		key: z.string().min(1).describe('Feature flag key from the code registry.'),
		orgId: z
			.string()
			.optional()
			.describe('Stable organization id (orgs.id) for the org row.'),
		orgSlug: z
			.string()
			.optional()
			.describe('Organization handle when orgId is omitted.'),
		enabled: z
			.boolean()
			.optional()
			.describe('Org row enabled state. Required unless clear is true.'),
		note: z
			.string()
			.max(500)
			.optional()
			.describe('Operator note for why the org row exists.'),
		clear: z
			.boolean()
			.optional()
			.describe('When true, remove the org row instead of setting it.'),
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
				message: 'Provide enabled when setting an org row, or clear: true.',
				path: ['enabled'],
			})
		}
		if (value.orgId === undefined && value.orgSlug === undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Provide either orgId or orgSlug.',
				path: ['orgId'],
			})
		}
		if (value.orgId !== undefined && value.orgSlug !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Provide either orgId or orgSlug, not both.',
				path: ['orgSlug'],
			})
		}
	})

const outputSchema = z.object({
	flag: adminFeatureFlagSchema,
	cleared: z.boolean(),
})

export const adminFeatureFlagOrgOverrideCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminFeatureFlagOrgOverride',
		contextRuns: 'deny',
		description:
			'Set or clear a per-org feature flag row by org id or slug, so every member of the org gets the flag in one shot. Per-user overrides still win; the org row applies when the request runs in that org. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'override',
			'per-org',
			'organization',
			'team',
			'toggle',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagOrgOverride',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const target = await resolveTargetOrg(ctx.env.APP_DB, {
						orgId: args.orgId,
						orgSlug: args.orgSlug,
					})
					const clear = args.clear === true
					if (clear) {
						const cleared = await clearFeatureFlagOrgOverride(ctx.env.APP_DB, {
							key,
							orgId: target.orgId,
						})
						if (!cleared) {
							throw new McpCallerError(
								`No org row exists for feature flag "${key}" and orgId ${target.orgId}.`,
							)
						}
					} else {
						const admin = await resolveActingAdminPerson(ctx)
						await setFeatureFlagOrgOverride(ctx.env.APP_DB, {
							key,
							orgId: target.orgId,
							enabled: args.enabled === true,
							note: args.note,
							updatedByStableUserId: admin.stableUserId,
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
						`key=${flag.key};cleared=${cleared};orgOverrides=${flag.orgOverrides.length}`,
				},
			)
		},
	},
)

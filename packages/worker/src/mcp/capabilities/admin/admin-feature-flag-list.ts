import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { missingSuccessMetricNotice } from '#universal/feature-flags/registry.ts'
import { listFeatureFlagsForAdmin } from '#worker/feature-flags/service.ts'
import { attachFeatureFlagMetricReadouts } from '#worker/feature-flags/success-metric-readout.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { adminFeatureFlagSchema } from './feature-flag-shared.ts'

const outputSchema = z.object({
	flags: z.array(
		adminFeatureFlagSchema.extend({
			successMetricNotice: z.string().optional(),
		}),
	),
})

export const adminFeatureFlagListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminFeatureFlagList',
		contextRuns: 'deny',
		description:
			"List feature flags for admin review, including registry metadata, global state, per-user overrides, and each flag's declared success metric with its on/off cohort readout (exposures joined with usage events, current month to date). Registry flags without a success metric carry a successMetricNotice strongly recommending one. Admin-only; never returns user content.",
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'rollout',
			'overrides',
			'toggles',
			'success metric',
			'metrics',
			'readout',
			'experiment',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagList',
				async () => {
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					await attachFeatureFlagMetricReadouts(ctx.env, flags)
					return {
						flags: flags.map((flag) => ({
							...flag,
							...(flag.stale || flag.successMetric
								? {}
								: { successMetricNotice: missingSuccessMetricNotice }),
						})),
					}
				},
			)
		},
	},
)

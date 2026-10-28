import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadAdminOrgLimits } from '#worker/admin/org-limit-overrides.ts'
import { adminCapabilityAccess } from './admin-shared.ts'
import {
	adminOrgLimitsSchema,
	adminOrgTargetSchema,
} from './org-limit-override-shared.ts'

export const adminOrgLimitsGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminOrgLimitsGet',
		contextRuns: 'deny',
		description:
			'Read one org’s overridable daily, weekly, and monthly caps: the plan limit, any admin override (value, expiry, reason, who set it), and the effective limit enforcement uses. Works for personal and team orgs.',
		keywords: [
			'admin',
			'limits',
			'caps',
			'override',
			'entitlements',
			'quota',
			'org',
		],
		inputSchema: adminOrgTargetSchema,
		outputSchema: adminOrgLimitsSchema,
		async handler(args, ctx) {
			return await loadAdminOrgLimits({
				db: ctx.env.APP_DB,
				target: { orgId: args.orgId, org: args.org },
			})
		},
	},
)

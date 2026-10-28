import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listPlatformProviderMarks } from '#worker/integrations/provider-marks.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	platformProviderMarkPublicSchema,
	toPlatformProviderMarkPublic,
} from './admin-platform-provider-mark-save.ts'

const inputSchema = z.object({}).strict()

const outputSchema = z.object({
	marks: z.array(platformProviderMarkPublicSchema),
})

export const adminPlatformProviderMarkListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPlatformProviderMarkList',
		contextRuns: 'deny',
		description:
			'List operator-owned provider brand marks used after an explicit upload and before auto-favicon on saved integrations and MCP servers. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'provider',
			'mark',
			'logo',
			'icon',
			'integration',
			'list',
		],
		inputSchema,
		outputSchema,
		async handler(_args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlatformProviderMarkList',
				async () => {
					const marks = await listPlatformProviderMarks({
						db: ctx.env.APP_DB,
					})
					return { marks: marks.map(toPlatformProviderMarkPublic) }
				},
			)
		},
	},
)

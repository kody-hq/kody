import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	deletePlatformProviderMark,
	deletePlatformProviderMarkLogoAsset,
	getPlatformProviderMarkBySlug,
} from '#worker/integrations/provider-marks.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		slug: z.string().min(1).describe('Provider mark slug to delete.'),
	})
	.strict()

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const adminPlatformProviderMarkDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminPlatformProviderMarkDelete',
		contextRuns: 'deny',
		description:
			'Delete an operator-owned provider brand mark and its stored logo. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'provider',
			'mark',
			'logo',
			'icon',
			'integration',
			'delete',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlatformProviderMarkDelete',
				async () => {
					const existing = await getPlatformProviderMarkBySlug({
						db: ctx.env.APP_DB,
						slug: args.slug,
					})
					if (existing?.logoKey && !ctx.env.COMMUNITY_ASSETS) {
						throw new McpCallerError('Logo storage is not configured.')
					}
					const deleted = await deletePlatformProviderMark({
						db: ctx.env.APP_DB,
						slug: args.slug,
					})
					if (deleted && ctx.env.COMMUNITY_ASSETS) {
						await deletePlatformProviderMarkLogoAsset({
							env: { COMMUNITY_ASSETS: ctx.env.COMMUNITY_ASSETS },
							logoKey: existing?.logoKey ?? null,
						})
					}
					return { deleted }
				},
				{
					successReason: () => `platform_provider_mark=${args.slug.trim()}`,
				},
			)
		},
	},
)

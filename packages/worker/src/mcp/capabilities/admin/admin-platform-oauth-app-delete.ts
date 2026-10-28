import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deletePlatformOauthAppLogoAsset } from '#worker/integrations/platform-app-logo.ts'
import {
	deletePlatformOauthApp,
	getPlatformOauthAppBySlug,
} from '#worker/integrations/platform-apps.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		slug: z.string().min(1).describe('Platform OAuth app slug to delete.'),
	})
	.strict()

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const adminPlatformOauthAppDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminPlatformOauthAppDelete',
		contextRuns: 'deny',
		description:
			'Delete a platform (built-in) OAuth app. Fails while user connections still reference it — disable the app instead when users are connected. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'oauth',
			'app',
			'built-in',
			'integration',
			'delete',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlatformOauthAppDelete',
				async () => {
					const existing = await getPlatformOauthAppBySlug({
						db: ctx.env.APP_DB,
						slug: args.slug,
						includeDisabled: true,
					})
					const deleted = await deletePlatformOauthApp({
						db: ctx.env.APP_DB,
						slug: args.slug,
					})
					if (deleted) {
						await deletePlatformOauthAppLogoAsset({
							env: ctx.env,
							logoKey: existing?.logoKey ?? null,
						})
					}
					return { deleted }
				},
				{
					successReason: () => `platform_oauth_app=${args.slug.trim()}`,
				},
			)
		},
	},
)

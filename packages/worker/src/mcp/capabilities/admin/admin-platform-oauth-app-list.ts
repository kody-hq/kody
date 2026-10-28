import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	platformOauthAppPublicSchema,
	toPlatformOauthAppPublic,
} from '#mcp/capabilities/integrations/platform-app-shared.ts'
import {
	countConnectionsForPlatformApp,
	listPlatformOauthApps,
} from '#worker/integrations/platform-apps.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		includeDisabled: z.boolean().optional(),
	})
	.strict()

const outputSchema = z.object({
	apps: z.array(
		platformOauthAppPublicSchema.extend({
			hasClientSecret: z.boolean(),
			connectionCount: z.number().int().nonnegative(),
		}),
	),
})

export const adminPlatformOauthAppListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPlatformOauthAppList',
		contextRuns: 'deny',
		description:
			'List platform (built-in) OAuth apps with per-app user connection counts. Secret values are never included. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'oauth',
			'app',
			'built-in',
			'integration',
			'list',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlatformOauthAppList',
				async () => {
					const apps = await listPlatformOauthApps({
						db: ctx.env.APP_DB,
						includeDisabled: args.includeDisabled ?? true,
					})
					const withCounts = await Promise.all(
						apps.map(async (app) => ({
							...toPlatformOauthAppPublic(app),
							hasClientSecret: app.hasClientSecret,
							connectionCount: await countConnectionsForPlatformApp({
								db: ctx.env.APP_DB,
								slug: app.slug,
							}),
						})),
					)
					return { apps: withCounts }
				},
			)
		},
	},
)

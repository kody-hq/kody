import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegrationOrgWide } from '#mcp/capabilities/integrations/authorize-integration.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import {
	listJoinedIntegrations,
	listOauthApps,
} from '#worker/integrations/service.ts'
import { oauthAppPublicSchema, toOauthAppPublic } from './oauth-app-shared.ts'

const outputSchema = z.object({
	apps: z.array(oauthAppPublicSchema),
})

export const integrationOauthAppListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationOauthAppList',
		contextRuns: 'allow',
		orgPermission: 'integration:read',
		description:
			'List OAuth apps for the signed-in user with connection counts and the connection names that share each app. Use this before rotating client credentials so one write updates every sibling connection.',
		keywords: [
			'integration',
			'oauth',
			'app',
			'client',
			'credentials',
			'list',
			'connections',
			'shared',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeIntegrationOrgWide(ctx, 'integration:read')
			const [apps, joined] = await Promise.all([
				listOauthApps({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
				}),
				listJoinedIntegrations({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
				}),
			])
			const connectionsByAppSlug = new Map<
				string,
				Array<{ name: string; accountLabel: string | null }>
			>()
			for (const entry of joined) {
				if (entry.lane !== 'user') continue
				const existing = connectionsByAppSlug.get(entry.app.slug) ?? []
				existing.push({
					name: entry.connection.name,
					accountLabel: entry.connection.accountLabel,
				})
				connectionsByAppSlug.set(entry.app.slug, existing)
			}
			return {
				apps: apps.map((app) =>
					toOauthAppPublic(app, connectionsByAppSlug.get(app.slug) ?? []),
				),
			}
		},
	},
)

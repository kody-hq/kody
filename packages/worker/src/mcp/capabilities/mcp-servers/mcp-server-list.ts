import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { loadIntegrationListScope } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { listScopeIncludes } from '#worker/authorization/authorize.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import {
	listMcpServerSettings,
	persistMcpServerLastErrorIfChanged,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubSnapshotOrNull,
	mcpServerCallerOrgSlug,
	mcpServerStatusSchema,
} from './shared.ts'

const outputSchema = z.object({
	oauthClientOrigin: z.string(),
	oauthCallbackUrl: z.string(),
	oauthClientMetadataUrl: z.string().nullable(),
	servers: z.array(mcpServerStatusSchema),
})

export const mcpServerListCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerList',
		contextRuns: 'allow',
		orgPermission: 'integration:read',
		description:
			"List the signed-in user's saved MCP servers with live connection status, pending OAuth authUrls (Kody consent pages the user opens to approve access), whether stored tokens include a refresh token, discovered tool names, durable lastError when post-IdP settle or token refresh did not reach ready, and package usage (any context vs locked to listed packages).",
		keywords: [
			'mcp',
			'server',
			'list',
			'status',
			'connection',
			'tools',
			'client',
			'usage',
			'lock',
			'package',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const oauth = resolveMcpServerOAuthClientUrls({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const [allSettings, hubSnapshot, scope] = await Promise.all([
				listMcpServerSettings({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
				}),
				loadMcpClientHubSnapshotOrNull({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					waitUntil: ctx.waitUntil,
				}),
				loadIntegrationListScope(ctx, 'integration:read'),
			])
			const settings = allSettings.filter((setting) =>
				listScopeIncludes(scope, setting.id),
			)
			await Promise.all(
				settings.map((setting) => {
					const snapshot =
						hubSnapshot?.servers.find(
							(server) => server.serverId === setting.id,
						) ?? null
					return persistMcpServerLastErrorIfChanged({
						env: ctx.env,
						userId: ownerIdFromCaller(ctx.callerContext),
						id: setting.id,
						state: snapshot?.state ?? 'disconnected',
						lastError: snapshot?.lastError ?? null,
					})
				}),
			)
			return {
				oauthClientOrigin: oauth.clientOrigin,
				oauthCallbackUrl: oauth.callbackUrl,
				oauthClientMetadataUrl: oauth.clientMetadataUrl,
				servers: settings.map((setting) =>
					buildMcpServerStatusView({
						setting,
						snapshot:
							hubSnapshot?.servers.find(
								(server) => server.serverId === setting.id,
							) ?? null,
						authorizeLink: {
							appOrigin: oauth.clientOrigin,
							orgSlug: mcpServerCallerOrgSlug(ctx.callerContext),
						},
						oauthCallbackUrl: oauth.callbackUrl,
						oauthClientOrigin: oauth.clientOrigin,
						oauthClientMetadataUrl: oauth.clientMetadataUrl,
					}),
				),
			}
		},
	},
)

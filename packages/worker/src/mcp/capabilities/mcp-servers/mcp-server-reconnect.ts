import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeMcpServer } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { mcpOAuthAttemptActorFromIds } from '#worker/mcp-client/oauth-attempt.ts'
import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import {
	persistMcpServerLastErrorIfChanged,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'
import { mcpServerCallerOrgSlug, resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	state: z.string(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	oauthClientOrigin: z.string(),
	oauthCallbackUrl: z.string(),
	oauthClientMetadataUrl: z.string().nullable(),
})

export const mcpServerReconnectCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerReconnect',
		contextRuns: 'allow',
		orgPermission: 'integration:write',
		description:
			'Retry connecting to a saved MCP server that is failed or disconnected. Tries stored OAuth refresh first; an authUrl is the Kody consent page the user opens to re-authorize. Surfaces a durable lastError when refresh failed.',
		keywords: ['mcp', 'server', 'reconnect', 'retry', 'connection', 'client'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			server: z.string().min(1).describe('The saved MCP server id or name.'),
		}),
		outputSchema,
		async handler(args: { server: string }, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const setting = await resolveMcpServerSetting({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				server: args.server,
			})
			await authorizeMcpServer(ctx, 'integration:write', setting)
			const oauth = resolveMcpServerOAuthClientUrls({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const ownerOrgId = ownerIdFromCaller(ctx.callerContext)
			const hub = createMcpClientHubClient({
				env: ctx.env,
				userId: ownerOrgId,
				waitUntil: ctx.waitUntil,
			})
			const result = await hub.reconnectServer({
				serverId: setting.id,
				callbackUrl: oauth.callbackUrl,
				actor: mcpOAuthAttemptActorFromIds({
					ownerOrgId,
					personId: ctx.callerContext.user?.userId,
				}),
			})
			await persistMcpServerLastErrorIfChanged({
				env: ctx.env,
				userId: ownerOrgId,
				id: setting.id,
				state: result.state,
				lastError: result.lastError ?? null,
			})
			return {
				id: setting.id,
				name: setting.name,
				state: result.state,
				toolCount: result.toolCount,
				authUrl: result.authorizationPending
					? buildMcpServerAuthorizeUrl({
							appOrigin: oauth.clientOrigin,
							orgSlug: mcpServerCallerOrgSlug(ctx.callerContext),
							serverId: setting.id,
						})
					: null,
				error: result.error
					? enrichMcpOAuthProviderError(result.error, oauth)
					: null,
				oauthClientOrigin: oauth.clientOrigin,
				oauthCallbackUrl: oauth.callbackUrl,
				oauthClientMetadataUrl: oauth.clientMetadataUrl,
			}
		},
	},
)

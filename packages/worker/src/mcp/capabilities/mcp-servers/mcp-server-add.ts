import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import {
	addMcpServer,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'
import { mcpServerCallerOrgSlug } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	state: z.string(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	oauthClientOrigin: z.string(),
	oauthCallbackUrl: z.string(),
	oauthClientMetadataUrl: z.string().nullable(),
	nextStep: z.string(),
})

export const mcpServerAddCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerAdd',
		contextRuns: 'deny',
		orgPermission: 'integration:create',
		description:
			'Add a remote MCP server for the signed-in user and connect to it. Servers that require OAuth return an authUrl: a signed-in Kody consent page the user opens and confirms before Kody sends them to the provider; other servers connect immediately. Pass bearerToken for servers that authenticate with a static Authorization header instead of (or in addition to) OAuth. Connected server tools become kody.mcp["server-name"].tool_name(...) capabilities. When OAuth fails with origin or redirect URI errors, the remote authorization server must allow Kody\'s oauthClientOrigin, oauthCallbackUrl, and oauthClientMetadataUrl (CIMD client_id) when present.',
		keywords: [
			'mcp',
			'server',
			'add',
			'connect',
			'client',
			'oauth',
			'bearer',
			'token',
			'authorization',
			'remote',
			'tools',
			'integration',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Short kebab-case name for the server (lowercase letters, numbers, dashes). Used as kody.mcp["name"] in execute code.',
				),
			url: z
				.string()
				.min(1)
				.describe(
					'The remote MCP server endpoint URL. Must be https (http is only allowed for localhost during development).',
				),
			bearerToken: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional static credential for Authorization. Bare tokens are sent as Bearer <token>; values that already include an auth scheme (Bearer, token, etc.) are sent as-is. Stored only in the per-user MCP client hub, never returned later.',
				),
		}),
		outputSchema,
		async handler(
			args: { name: string; url: string; bearerToken?: string },
			ctx: CapabilityContext,
		) {
			requireMcpUser(ctx.callerContext)
			const oauth = resolveMcpServerOAuthClientUrls({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const { setting, connection } = await addMcpServer({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				personId: ctx.callerContext.user?.userId,
				name: args.name,
				url: args.url,
				baseUrl: oauth.clientOrigin,
				bearerToken: args.bearerToken,
				waitUntil: ctx.waitUntil,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			const error = connection.error
				? enrichMcpOAuthProviderError(connection.error, oauth)
				: null
			const authUrl = connection.authorizationPending
				? buildMcpServerAuthorizeUrl({
						appOrigin: oauth.clientOrigin,
						orgSlug: mcpServerCallerOrgSlug(ctx.callerContext),
						serverId: setting.id,
					})
				: null
			const nextStep = authUrl
				? `The server requires OAuth authorization. Ask the user to open ${authUrl}, review the server and authorization server shown there, and click Continue to authorize Kody. If the provider rejects Kody's origin, redirect URI, or CIMD client_id, they must allow ${oauth.clientOrigin}, ${oauth.callbackUrl}${oauth.clientMetadataUrl ? `, and ${oauth.clientMetadataUrl}` : ''}, then reconnect the server. After authorizing, check mcpServerList.`
				: connection.state === 'ready'
					? `Connected with ${connection.toolCount} tool(s). Use search or metaListCapabilities to discover kody.mcp["${setting.name}"] capabilities.`
					: error
						? `Connection state is "${connection.state}": ${error}`
						: `Connection state is "${connection.state}". Check mcpServerList and use mcpServerReconnect if it does not become ready.`
			return {
				id: setting.id,
				name: setting.name,
				url: setting.url,
				state: connection.state,
				toolCount: connection.toolCount,
				authUrl,
				error,
				oauthClientOrigin: oauth.clientOrigin,
				oauthCallbackUrl: oauth.callbackUrl,
				oauthClientMetadataUrl: oauth.clientMetadataUrl,
				nextStep,
			}
		},
	},
)

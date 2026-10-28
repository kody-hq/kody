import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeMcpServer } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	state: z.string(),
	toolCount: z.number().int().nonnegative(),
	error: z.string().nullable(),
})

export const mcpServerRefreshCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerRefresh',
		contextRuns: 'allow',
		orgPermission: 'integration:write',
		description:
			'Re-discover the tools exposed by a connected MCP server (for example after the server ships new tools).',
		keywords: ['mcp', 'server', 'refresh', 'tools', 'discover', 'client'],
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
			const hub = createMcpClientHubClient({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				waitUntil: ctx.waitUntil,
			})
			const result = await hub.refreshServer({ serverId: setting.id })
			return {
				id: setting.id,
				name: setting.name,
				state: result.state,
				toolCount: result.toolCount,
				error: result.error,
			}
		},
	},
)

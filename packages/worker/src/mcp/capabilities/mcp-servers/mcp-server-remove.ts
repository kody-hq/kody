import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeMcpServer } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteMcpServer } from '#worker/mcp-client/settings-service.ts'
import { resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	removed: z.boolean(),
	id: z.string(),
	name: z.string(),
})

export const mcpServerRemoveCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerRemove',
		contextRuns: 'deny',
		orgPermission: 'integration:delete',
		description:
			'Remove a saved MCP server: disconnects it, deletes stored OAuth tokens and client registrations, and removes its kody.mcp capabilities.',
		keywords: ['mcp', 'server', 'remove', 'delete', 'disconnect', 'client'],
		readOnly: false,
		idempotent: true,
		destructive: true,
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
			await authorizeMcpServer(ctx, 'integration:delete', setting)
			const removed = await deleteMcpServer({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				id: setting.id,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			return {
				removed,
				id: setting.id,
				name: setting.name,
			}
		},
	},
)

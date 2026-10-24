import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeMcpServer } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildMcpServerUsageUrl } from '#worker/mcp-client/package-access.ts'
import { lockMcpServerToPackage } from '#worker/mcp-client/settings-service.ts'
import { resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	usage_mode: z.literal('packages'),
	allowed_package_ids: z.array(z.string()),
	usage_url: z.string(),
})

export const mcpServerLockCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcpServerLock',
		orgPermission: 'integration:use',
		description:
			'Lock a saved MCP server to a package so only that package (and any previously granted packages) can call kody.mcp["server-name"]. Execute and other packages are denied. Agents can lock; unlocking or removing a grant is website-only at /account/mcp-servers/:serverId.',
		keywords: [
			'mcp',
			'server',
			'lock',
			'package',
			'usage',
			'restrict',
			'grant',
			'client',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			server: z.string().min(1).describe('The saved MCP server id or name.'),
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that may call this MCP server.'),
		}),
		outputSchema,
		async handler(
			args: { server: string; package_id: string },
			ctx: CapabilityContext,
		) {
			const user = requireMcpUser(ctx.callerContext)
			const setting = await resolveMcpServerSetting({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				server: args.server,
			})
			await authorizeMcpServer(ctx, 'integration:use', setting)
			try {
				const updated = await lockMcpServerToPackage({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					id: setting.id,
					packageId: args.package_id,
					audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
				})
				return {
					id: updated.id,
					name: updated.name,
					usage_mode: 'packages' as const,
					allowed_package_ids: updated.allowedPackageIds,
					usage_url: buildMcpServerUsageUrl({
						baseUrl: ctx.callerContext.baseUrl,
						orgSlug:
							ctx.callerContext.request?.org.slug?.trim() ||
							user.username?.trim() ||
							'',
						serverId: updated.id,
					}),
				}
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to lock this MCP server to a package.',
					{ cause: error },
				)
			}
		},
	},
)

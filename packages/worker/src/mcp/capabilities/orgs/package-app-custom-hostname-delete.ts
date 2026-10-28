import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageAppCustomHostnameActingUserId } from '#mcp/capabilities/orgs/package-app-custom-hostname-acting-user.ts'
import { packageAppCustomDomainsFlagKey } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import {
	deletePackageAppCustomHostname,
	PackageAppCustomHostnameError,
} from '#worker/package-app-custom-hostnames/service.ts'

export const packageAppCustomHostnameDeleteCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameDelete',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		featureFlag: packageAppCustomDomainsFlagKey,
		description:
			'Remove a custom hostname from this organization’s package apps and delete it from Cloudflare for SaaS. Pass hostname or the row id from packageAppCustomHostnameList.',
		keywords: ['custom domain', 'hostname', 'delete', 'remove', 'DNS'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			hostname: z.string().min(1).optional(),
			id: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			id: z.string(),
			hostname: z.string(),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (!args.hostname && !args.id) {
				throw new McpCallerError('Pass hostname or id.')
			}
			const actingUserId = await resolvePackageAppCustomHostnameActingUserId({
				db: ctx.env.APP_DB,
				stableUserId: request.actor?.userId,
			})
			try {
				return await deletePackageAppCustomHostname({
					env: ctx.env,
					orgId: request.org.id,
					actingUserId,
					hostname: args.hostname,
					id: args.id,
				})
			} catch (error) {
				if (error instanceof PackageAppCustomHostnameError) {
					throw new McpCallerError(error.message)
				}
				throw error
			}
		},
	},
)

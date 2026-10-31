import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { packageAppCustomHostnameRowSchema } from '#mcp/capabilities/orgs/package-app-custom-hostname-schemas.ts'
import { resolvePackageAppCustomHostnameActingUserId } from '#mcp/capabilities/orgs/package-app-custom-hostname-acting-user.ts'
import {
	listPackageAppCustomHostnames,
	PackageAppCustomHostnameError,
} from '#worker/package-app-custom-hostnames/service.ts'

export const packageAppCustomHostnameListCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameList',
		contextRuns: 'allow',
		orgPermission: 'org:write',
		description:
			'List custom hostnames registered for this organization’s package apps, including app-level and org-level bindings and their Cloudflare verification status.',
		keywords: ['custom domain', 'hostname', 'package app', 'list', 'DNS'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			hostnames: z.array(packageAppCustomHostnameRowSchema),
		}),
		async handler(_args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			await resolvePackageAppCustomHostnameActingUserId({
				db: ctx.env.APP_DB,
				stableUserId: request.actor?.userId,
			})
			try {
				return await listPackageAppCustomHostnames({
					env: ctx.env,
					orgId: request.org.id,
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

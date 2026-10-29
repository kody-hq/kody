import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import {
	packageAppCustomHostnameDnsHintSchema,
	packageAppCustomHostnameRowSchema,
	packageAppCustomHostnameSetupSchema,
	packageAppCustomHostnameVerificationSchema,
} from '#mcp/capabilities/orgs/package-app-custom-hostname-schemas.ts'
import { resolvePackageAppCustomHostnameActingUserId } from '#mcp/capabilities/orgs/package-app-custom-hostname-acting-user.ts'
import {
	PackageAppCustomHostnameError,
	syncPackageAppCustomHostname,
} from '#worker/package-app-custom-hostnames/service.ts'

export const packageAppCustomHostnameSyncCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameSync',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		description:
			'Refresh one custom hostname from Cloudflare for SaaS right now: pull hostname and SSL status, ownership TXT / SSL validation records, update the local row, and return setup (the exact DNS records and steps). Optional: Kody already re-checks pending hostnames every few minutes, so call this once for an immediate check instead of polling. Pass hostname or the row id from packageAppCustomHostnameList.',
		keywords: [
			'custom domain',
			'hostname',
			'sync',
			'verify',
			'DNS',
			'TXT',
			'SSL',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			hostname: z.string().min(1).optional(),
			id: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			hostname: packageAppCustomHostnameRowSchema,
			dns: packageAppCustomHostnameDnsHintSchema,
			verification: packageAppCustomHostnameVerificationSchema,
			setup: packageAppCustomHostnameSetupSchema,
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (!args.hostname && !args.id) {
				throw new McpCallerError('Pass hostname or id.')
			}
			await resolvePackageAppCustomHostnameActingUserId({
				db: ctx.env.APP_DB,
				stableUserId: request.actor?.userId,
			})
			try {
				return await syncPackageAppCustomHostname({
					env: ctx.env,
					orgId: request.org.id,
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

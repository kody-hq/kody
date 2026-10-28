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
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'
import { resolvePackageAppCustomHostnameActingUserId } from '#mcp/capabilities/orgs/package-app-custom-hostname-acting-user.ts'
import { packageAppCustomDomainsFlagKey } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import {
	addPackageAppCustomHostname,
	PackageAppCustomHostnameError,
} from '#worker/package-app-custom-hostnames/service.ts'

export const packageAppCustomHostnameAddCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameAdd',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		featureFlag: packageAppCustomDomainsFlagKey,
		description:
			'Register a custom hostname for this organization’s package apps (Cloudflare for SaaS). App-level hostnames apply to one internet-visible public app and serve it at the host root. Org-level hostnames apply to private apps and serve them at /packages/{kodyId} on the custom host. Only org admins on a paid plan may add domains. Hostnames under Kody’s own domains (for example kody.codes, kody.run) and workers.dev are rejected. The result includes setup: the exact DNS records (all DNS only, proxy off) and plain steps. Kody re-checks pending hostnames automatically every few minutes, so there is no need to loop on packageAppCustomHostnameSync. Optional ssl_method=txt pre-validates the certificate via TXT before traffic switches. Guide: guide:package_app_custom_domains.',
		keywords: [
			'custom domain',
			'hostname',
			'package app',
			'kody.run',
			'DNS',
			'SaaS',
			'TXT',
			'verification',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			hostname: z.string().min(1).describe('Customer hostname to register.'),
			binding_kind: z
				.enum(packageAppCustomHostnameBindingKinds)
				.describe('app = one public internet-visible app; org = private apps.'),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe('Required when binding_kind is app.'),
			ssl_method: z
				.enum(['http', 'txt'])
				.optional()
				.describe(
					'Cloudflare SSL validation method. Default http. Use txt for pre-validation before switching traffic.',
				),
		}),
		outputSchema: z.object({
			hostname: packageAppCustomHostnameRowSchema,
			dns: packageAppCustomHostnameDnsHintSchema,
			verification: packageAppCustomHostnameVerificationSchema,
			setup: packageAppCustomHostnameSetupSchema,
			billing_note: z.string().nullable(),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (!request.actor) {
				throw new McpCallerError(
					'Custom hostnames must be added by a person with org:write.',
				)
			}
			const actingUserId = await resolvePackageAppCustomHostnameActingUserId({
				db: ctx.env.APP_DB,
				stableUserId: request.actor.userId,
			})
			try {
				return await addPackageAppCustomHostname({
					env: ctx.env,
					orgId: request.org.id,
					actingUserId,
					createdByUserId: request.actor.userId,
					bindingKind: args.binding_kind,
					hostname: args.hostname,
					packageId: args.package_id,
					sslMethod: args.ssl_method,
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

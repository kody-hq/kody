import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminRemovePackageAppCustomHostname,
	PackageAppCustomHostnameError,
} from '#worker/package-app-custom-hostnames/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminPackageAppCustomHostnameRemoveInputSchema = z.object({
	hostname: z
		.string()
		.min(1)
		.describe('Customer hostname to take down, for example apps.example.com.'),
	reason: z
		.string()
		.trim()
		.min(10)
		.max(500)
		.describe(
			'Audit reason for the takedown (abuse report, phishing, etc.), at least 10 characters.',
		),
})

const outputSchema = z.object({
	ok: z.literal(true),
	id: z.string(),
	hostname: z.string(),
	binding_kind: z.enum(packageAppCustomHostnameBindingKinds),
	org_id: z.string().nullable(),
	package_id: z.string().nullable(),
	hostname_status: z.string(),
})

/**
 * Abuse takedown for any org's package-app custom hostname. Deletes it from
 * Cloudflare for SaaS and the DB; the owning org can add it again later
 * within its normal limits.
 */
export const adminPackageAppCustomHostnameRemoveCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		name: 'adminPackageAppCustomHostnameRemove',
		contextRuns: 'deny',
		description:
			"Take down another org's package-app custom hostname (abuse, phishing): delete it from Cloudflare for SaaS and the database so Kody stops serving it. Requires an audit reason. Admin-only and destructive.",
		keywords: [
			'admin',
			'custom domain',
			'custom hostname',
			'takedown',
			'abuse',
			'remove',
			'package app',
		],
		destructive: true,
		idempotent: false,
		inputSchema: adminPackageAppCustomHostnameRemoveInputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPackageAppCustomHostnameRemove',
				async () => {
					try {
						return await adminRemovePackageAppCustomHostname({
							env: ctx.env,
							hostname: args.hostname,
						})
					} catch (error) {
						if (error instanceof PackageAppCustomHostnameError) {
							throw new McpCallerError(error.message)
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						[
							`hostname=${result.hostname}`,
							`id=${result.id}`,
							`binding_kind=${result.binding_kind}`,
							`org_id=${result.org_id ?? ''}`,
							`package_id=${result.package_id ?? ''}`,
							`reason=${args.reason}`,
						].join(';'),
				},
			)
		},
	})

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	legacyFillModes,
	legacyFillPlacements,
	legacyFillSurfaces,
} from '#worker/credentials/legacy-fill-audit.ts'
import {
	auditDatabaseFromEnvOrThrow,
	orgAuditEventResults,
} from '#worker/orgs/org-audit.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const usageRow = z.object({
	placement: z.enum(legacyFillPlacements),
	surface: z.enum(legacyFillSurfaces),
	mode: z.enum(legacyFillModes),
	result: z.enum(orgAuditEventResults),
	count: z.int().nonnegative(),
})
const inputSchema = z.object({
	from: z.iso.datetime(),
	to: z.iso.datetime(),
	orgId: z.string().trim().min(1).optional(),
	packageId: z.string().trim().min(1).optional(),
})
const outputSchema = z.object({
	fills: z.array(usageRow),
	nameStoredSettings: z.object({
		webhookEndpoints: z.int().nonnegative(),
		providerBindings: z.int().nonnegative(),
	}),
})

export const adminLegacyCredentialUsageCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminLegacyCredentialUsage',
		contextRuns: 'deny',
		description:
			'Count legacy credential fill attempts by placement, surface, resolution mode and outcome. Optional owner and package filters. Includes current name-stored settings counts. Returns aggregate counts only.',
		keywords: ['admin', 'credentials', 'legacy', 'usage', 'deprecation'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			const from = new Date(args.from)
			const to = new Date(args.to)
			const interval = to.getTime() - from.getTime()
			if (interval <= 0 || interval > 7 * 24 * 60 * 60 * 1000) {
				throw new McpCallerError(
					'Choose a positive interval of no more than seven days.',
				)
			}
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminLegacyCredentialUsage',
				async () => {
					const auditDb = auditDatabaseFromEnvOrThrow(ctx.env)
					const orgClause = args.orgId ? ' AND org_id = ?' : ''
					const packageClause = args.packageId ? ' AND resource_id = ?' : ''
					const settingsFilter = `${args.orgId ? ' AND user_id = ?' : ''}${args.packageId ? ' AND package_id = ?' : ''}`
					const filters = [
						...(args.orgId ? [args.orgId] : []),
						...(args.packageId ? [args.packageId] : []),
					]
					const [rows, webhooks, providers] = await Promise.all([
						auditDb
							.prepare(
								`SELECT site.key AS placement,
							json_extract(details_json, '$.surface') AS surface,
							json_extract(details_json, '$.mode') AS mode,
							result, sum(site.value) AS count
						FROM org_audit_events, json_each(details_json, '$.counts') AS site
						WHERE action = 'credential.legacy_fill' AND created_at >= ? AND created_at < ?
							${orgClause}${packageClause}
						GROUP BY placement, surface, mode, result
						ORDER BY placement, surface, mode, result`,
							)
							.bind(from.toISOString(), to.toISOString(), ...filters)
							.all<z.infer<typeof usageRow>>(),
						ctx.env.APP_DB.prepare(
							`SELECT count(*) AS count FROM webhook_endpoints
						WHERE deleted_at IS NULL
							AND hmac_secret_name IS NOT NULL
							AND hmac_credential_id IS NULL${settingsFilter}`,
						)
							.bind(...filters)
							.first<number>('count'),
						ctx.env.APP_DB.prepare(
							`SELECT count(*) AS count FROM secret_provider_bindings
						WHERE deleted_at IS NULL AND door_credential_id IS NULL${settingsFilter}`,
						)
							.bind(...filters)
							.first<number>('count'),
					])
					return {
						fills: rows.results,
						nameStoredSettings: {
							webhookEndpoints: webhooks ?? 0,
							providerBindings: providers ?? 0,
						},
					}
				},
			)
		},
	},
)

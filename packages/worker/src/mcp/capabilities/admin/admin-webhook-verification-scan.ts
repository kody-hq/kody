import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { scanWebhookVerification } from '#worker/webhooks/verification-scan.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const runLogRetentionMs = 30 * 24 * 60 * 60 * 1000

const statusSchema = z.enum([
	'implicit_url_secret',
	'url_secret',
	'signature',
	'undeclared',
	'manifest_unavailable',
])

const inputSchema = z.object({
	since: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe(
			'ISO 8601 lower bound for counting successful deliveries. Defaults to 30 days ago (RunLog retention).',
		),
	includeDisabled: z
		.boolean()
		.default(false)
		.describe(
			'Also scan disabled (but undeleted) webhook URLs. Ingress 404s them until re-enabled.',
		),
	includeSignature: z
		.boolean()
		.default(false)
		.describe(
			'Also list webhooks that declare an HMAC signature scheme. Totals always count them.',
		),
})

const outputSchema = z.object({
	since: z.string(),
	endpointsScanned: z.number().int().nonnegative(),
	ownersFailed: z
		.array(z.string())
		.describe('Owners whose RunLog could not be read.'),
	truncated: z
		.boolean()
		.describe('True when a RunLog page cap cut an owner delivery count short.'),
	totals: z.object({
		implicit_url_secret: z.number().int().nonnegative(),
		url_secret: z.number().int().nonnegative(),
		signature: z.number().int().nonnegative(),
		undeclared: z.number().int().nonnegative(),
		manifest_unavailable: z.number().int().nonnegative(),
		implicitUrlSecretOwners: z.number().int().nonnegative(),
		implicitUrlSecretDelivered: z.number().int().nonnegative(),
	}),
	endpoints: z.array(
		z.object({
			ownerId: z.string(),
			ownerSlug: z.string().nullable(),
			endpointId: z.string(),
			packageId: z.string(),
			packageKodyId: z.string().nullable(),
			webhookName: z.string(),
			enabled: z.boolean(),
			status: statusSchema,
			verification: z
				.object({
					type: z.string(),
					header: z.string().nullable(),
					secretName: z.string().nullable(),
				})
				.nullable(),
			delivered: z
				.number()
				.int()
				.nonnegative()
				.describe('Successful deliveries since `since`.'),
			lastDeliveredAt: z.string().nullable(),
		}),
	),
})

export const adminWebhookVerificationScanCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWebhookVerificationScan',
		contextRuns: 'deny',
		description:
			'List every live minted webhook URL across owners that authenticates by URL secret only, split into `implicit_url_secret` (manifest declares no `verification`) and `url_secret` (declares `verification: { type: "url-secret" }`), with successful deliveries since a time. Also counts webhooks that declare an HMAC scheme, are no longer declared, or whose manifest could not be read. Reporting only: undeclared webhooks stay supported. Reads manifests and each owner RunLog, so it is slow. Returns ids, slugs, names, header names, secret names, and counts only; never secrets or payloads. Admin-only.',
		keywords: [
			'admin',
			'webhook',
			'verification',
			'signature',
			'url secret',
			'migration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWebhookVerificationScan',
				async () =>
					scanWebhookVerification({
						env: ctx.env,
						since:
							args.since ??
							new Date(Date.now() - runLogRetentionMs).toISOString(),
						includeSignature: args.includeSignature,
						includeDisabled: args.includeDisabled,
					}),
				{
					successReason: (result) =>
						`endpoints=${String(result.endpointsScanned)};implicit_url_secret=${String(result.totals.implicit_url_secret)};owners=${String(result.totals.implicitUrlSecretOwners)}`,
				},
			)
		},
	},
)

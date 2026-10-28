import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { buildWebhookRejectionReport } from '#worker/webhooks/rejection-report.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const isoTimestampSchema = z.string().datetime({ offset: true })

const inputSchema = z.object({
	since: isoTimestampSchema.describe(
		'ISO 8601 lower bound on delivery start time, inclusive.',
	),
	until: isoTimestampSchema
		.optional()
		.describe('ISO 8601 upper bound, exclusive. Omit for now.'),
	httpStatus: z
		.number()
		.int()
		.min(400)
		.max(599)
		.default(401)
		.describe('Rejection status to count. Defaults to 401.'),
	error: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe(
			'Exact rejection code to count, for example missing_signature. Omit to count every rejection with httpStatus.',
		),
})

const endpointSchema = z.object({
	ownerId: z.string().describe('Owning org id.'),
	ownerSlug: z.string().nullable(),
	endpointId: z.string().nullable(),
	packageId: z.string().nullable(),
	packageKodyId: z.string().nullable(),
	webhookName: z.string().nullable(),
	rejected: z.number().int().nonnegative(),
	delivered: z
		.number()
		.int()
		.nonnegative()
		.describe('Successful deliveries in the same window.'),
	otherErrors: z.number().int().nonnegative(),
	firstRejectedAt: z.string().nullable(),
	lastRejectedAt: z.string().nullable(),
	lastDeliveredAt: z.string().nullable(),
})

const outputSchema = z.object({
	since: z.string(),
	until: z.string().nullable(),
	httpStatus: z.number().int(),
	error: z.string().nullable(),
	ownersScanned: z.number().int().nonnegative(),
	ownersFailed: z
		.array(z.string())
		.describe('Owners whose RunLog could not be read.'),
	truncated: z
		.boolean()
		.describe(
			'True when a RunLog page cap cut an owner scan short. `since`/`until` are applied in RunLog (newest-first pages); RunLog also keeps only the newest 2,000 runs per owner for 30 days.',
		),
	totals: z.object({
		owners: z.number().int().nonnegative(),
		endpoints: z.number().int().nonnegative(),
		rejected: z.number().int().nonnegative(),
	}),
	owners: z.array(
		z.object({
			ownerId: z.string(),
			ownerSlug: z.string().nullable(),
			endpoints: z.number().int().nonnegative(),
			rejected: z.number().int().nonnegative(),
		}),
	),
	endpoints: z.array(endpointSchema),
})

export const adminWebhookRejectionReportCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWebhookRejectionReport',
		contextRuns: 'deny',
		description:
			'Count rejected inbound webhook deliveries across every owner with a minted webhook URL since a time, by endpoint and owner, with successful deliveries in the same window. Filter by HTTP status (default 401) and exact rejection code such as missing_signature. Reads each owner RunLog, so it is slow; use it to size an incident. Returns ids, slugs, names, counts, and timestamps only; never payloads or secrets. Admin-only.',
		keywords: [
			'admin',
			'webhook',
			'rejections',
			'401',
			'missing_signature',
			'incident',
			'deliveries',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWebhookRejectionReport',
				async () =>
					buildWebhookRejectionReport({
						env: ctx.env,
						since: args.since,
						until: args.until ?? null,
						httpStatus: args.httpStatus,
						error: args.error ?? null,
					}),
				{
					successReason: (result) =>
						`since=${result.since};status=${String(result.httpStatus)};owners=${String(result.totals.owners)};endpoints=${String(result.totals.endpoints)};rejected=${String(result.totals.rejected)}`,
				},
			)
		},
	},
)

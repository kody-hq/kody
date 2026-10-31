import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { buildSeatQuantityReport } from '#worker/billing/seat-quantity-report.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	since: z.string().datetime().optional(),
	checkStripe: z.boolean().default(false),
	limit: z.number().int().min(1).max(200).default(100),
	offset: z.number().int().min(0).default(0),
})

const outputSchema = z.object({
	syncs: z.object({
		since: z.string(),
		events: z.number().int(),
		orgs: z.number().int(),
		changes: z.array(
			z.object({
				previousQuantity: z.number().int(),
				nextQuantity: z.number().int(),
				orgs: z.number().int(),
			}),
		),
	}),
	stripe: z
		.object({
			checked: z.number().int(),
			matching: z.number().int(),
			mismatched: z.number().int(),
			skipped: z.number().int(),
			mismatches: z.array(
				z.object({
					stripeQuantity: z.number().int(),
					liveSeats: z.number().int(),
					orgs: z.number().int(),
				}),
			),
			nextOffset: z.number().int().nullable(),
		})
		.optional(),
})

export const adminOrgSeatQuantityReportCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminOrgSeatQuantityReport',
		contextRuns: 'deny',
		description:
			'Read aggregate organization seat-quantity sync history and optionally compare live paid organization seats with Stripe without writing to Stripe.',
		keywords: ['admin', 'organization', 'org', 'seats', 'stripe', 'report'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrgSeatQuantityReport',
				() =>
					buildSeatQuantityReport({
						db: ctx.env.APP_DB,
						env: ctx.env,
						since:
							args.since ??
							new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
						checkStripe: args.checkStripe,
						limit: args.limit,
						offset: args.offset,
					}),
			)
		},
	},
)

import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadRecipientSuppression } from '#worker/email/recipient-suppression.ts'
import { listSystemEmailSends } from '#worker/email/system-email-sends.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	emailSuppressionSchema,
	toEmailSuppression,
} from './admin-email-suppression-shared.ts'

const inputSchema = z.object({
	recipient: z
		.string()
		.min(1)
		.optional()
		.describe('Only sends to this address.'),
	kind: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Only sends of this kind, for example guest_claim_code, email_verification, or operator.',
		),
	provider_message_id: z
		.string()
		.min(1)
		.optional()
		.describe('Look up one send by its Cloudflare Email Sending message id.'),
	since: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe('Only sends at or after this ISO timestamp.'),
	limit: z.number().int().min(1).max(200).optional(),
})

const sendSchema = z.object({
	provider_message_id: z.string(),
	recipient: z.string(),
	sender: z.string(),
	kind: z.string(),
	sent_at: z.string(),
	delivery_status: z
		.string()
		.nullable()
		.describe(
			'Latest Cloudflare delivery report for this send (delivered, deferred, bounced, failed, rejected, complained). Null means the provider accepted it and no report has matched yet.',
		),
	delivery_status_at: z.string().nullable(),
	hard_bounced_at: z.string().nullable(),
	suppression: emailSuppressionSchema
		.nullable()
		.describe(
			'Current bounce tracking or suppression for the recipient, including the latest bounce detail.',
		),
})

const outputSchema = z.object({
	sends: z.array(sendSchema),
	has_more: z.boolean(),
})

export const adminSystemEmailSendListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminSystemEmailSendList',
		contextRuns: 'deny',
		description:
			'List mail Kody sent from system senders (kody@ transactional mail such as guest claim codes and verification, plus adminSystemEmailSend operator mail), newest first, with each send’s Cloudflare provider message id, latest delivery report, and the recipient’s bounce or suppression state. Admin-only; use it to trace whether a system email was accepted, delivered, or bounced.',
		keywords: [
			'admin',
			'email',
			'system email',
			'sent',
			'delivery',
			'bounce',
			'message id',
			'trace',
			'kody@',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailSendList',
				async () => {
					const db = ctx.env.APP_DB
					const result = await listSystemEmailSends({
						db,
						recipient: args.recipient ?? null,
						kind: args.kind ?? null,
						providerMessageId: args.provider_message_id ?? null,
						since: args.since ?? null,
						limit: args.limit ?? 50,
					})
					const suppressions = new Map(
						await Promise.all(
							[...new Set(result.sends.map((send) => send.recipient))].map(
								async (recipient) =>
									[
										recipient,
										await loadRecipientSuppression({ db, recipient }),
									] as const,
							),
						),
					)
					return {
						sends: result.sends.map((send) => {
							const suppression = suppressions.get(send.recipient)
							return {
								provider_message_id: send.providerMessageId,
								recipient: send.recipient,
								sender: send.sender,
								kind: send.kind,
								sent_at: send.sentAt,
								delivery_status: send.deliveryStatus,
								delivery_status_at: send.deliveryStatusAt,
								hard_bounced_at: send.hardBouncedAt,
								suppression: suppression
									? toEmailSuppression(suppression)
									: null,
							}
						}),
						has_more: result.hasMore,
					}
				},
			)
		},
	},
)

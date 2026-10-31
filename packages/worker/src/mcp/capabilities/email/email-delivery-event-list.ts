import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listOwnerEmailDeliveryEvents } from '#worker/email/owner-email-reader.ts'
import { emailDeliveryEventTypeValues } from '#worker/email/types.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

const emailDeliveryEventSchema = z.object({
	id: z.string(),
	message_id: z.string().nullable(),
	inbox_id: z.string().nullable(),
	event_type: z.enum(emailDeliveryEventTypeValues),
	provider: z.string().nullable(),
	provider_message_id: z.string().nullable(),
	provider_event_id: z.string().nullable(),
	detail: z.record(z.string(), z.unknown()),
	created_at: z.string(),
})

function parseDetail(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
		// Corrupt historical detail must not fail the whole event list.
	}
	return {}
}

export const emailDeliveryEventListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDeliveryEventList',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'List stored email delivery events, including outbound provider lifecycle updates and SMTP details.',
		keywords: [
			'email',
			'delivery',
			'status',
			'bounce',
			'complaint',
			'smtp',
			'events',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			message_id: z.string().min(1).optional(),
			event_type: z.enum(emailDeliveryEventTypeValues).optional(),
			limit: z.number().int().positive().max(100).default(25),
		}),
		outputSchema: z.object({
			events: z.array(emailDeliveryEventSchema),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const events = await listOwnerEmailDeliveryEvents({
				env: ctx.env,
				ownerId: emailOwnerOrgId(ctx, user),
				messageId: args.message_id ?? null,
				eventType: args.event_type ?? null,
				limit: args.limit,
			})
			return {
				events: events.map((event) => ({
					id: event.id,
					message_id: event.messageId,
					inbox_id: event.inboxId,
					event_type: event.eventType,
					provider: event.provider,
					provider_message_id: event.providerMessageId,
					provider_event_id: event.providerEventId,
					detail: parseDetail(event.detailJson),
					created_at: event.createdAt,
				})),
			}
		},
	},
)

import { z } from 'zod'
import { maxOutboundEmailAttachments } from '#worker/email/outbound.ts'
import {
	defaultEmailMessageView,
	emailClassificationValues,
	emailDeliveryStatusValues,
	emailMessageViewValues,
	type EmailClassification,
	type EmailMessageRecord,
	type EmailMessageView,
	type EmailSenderRuleRecord,
	emailDirectionValues,
	emailProcessingStatusValues,
	emailSenderRuleEffectValues,
	emailSenderRuleKindValues,
} from '#worker/email/types.ts'

export const emailInboxSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	enabled: z.boolean(),
	addresses: z.array(
		z.object({
			id: z.string(),
			address: z.string(),
			enabled: z.boolean(),
			created_at: z.string(),
		}),
	),
	created_at: z.string(),
	updated_at: z.string(),
})

export const emailInboxListSchema = z.object({
	inboxes: z.array(emailInboxSchema),
})

export const emailMessageSummarySchema = z.object({
	id: z.string(),
	direction: z.enum(emailDirectionValues),
	inbox_id: z.string().nullable(),
	thread_id: z.string().nullable(),
	from_address: z.string().nullable(),
	envelope_from: z.string().nullable(),
	to_addresses: z.array(z.string()),
	subject: z.string().nullable(),
	message_id_header: z.string().nullable(),
	processing_status: z.enum(emailProcessingStatusValues),
	classification: z.enum(emailClassificationValues),
	classification_reason: z.string().nullable(),
	archived_at: z.string().nullable(),
	provider_message_id: z.string().nullable(),
	delivery_status: z.enum(emailDeliveryStatusValues).nullable(),
	delivery_status_at: z.string().nullable(),
	error: z.string().nullable(),
	received_at: z.string().nullable(),
	sent_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const emailMessageViewInputSchema = z
	.enum(emailMessageViewValues)
	.optional()
	.describe(
		'"inbox" (default) hides spam and archived mail; "accepted" / "quarantined" narrow the inbox; "spam" and "archived" show those folders; "all" returns everything. When classification is set and view is omitted, view defaults to "all".',
	)

/** `view` wins; an explicit classification filter alone searches everything. */
export function resolveEmailMessageView(input: {
	view?: EmailMessageView
	classification?: EmailClassification
}): EmailMessageView {
	if (input.view) return input.view
	return input.classification ? 'all' : defaultEmailMessageView
}

export const emailSenderRuleSchema = z.object({
	id: z.string(),
	kind: z.enum(emailSenderRuleKindValues),
	value: z.string(),
	effect: z.enum(emailSenderRuleEffectValues),
	note: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const emailAttachmentSchema = z.object({
	id: z.string(),
	filename: z.string().nullable(),
	content_type: z.string().nullable(),
	content_id: z.string().nullable(),
	disposition: z.string().nullable(),
	size: z.number().nullable(),
	storage_kind: z.string(),
	storage_key: z.string().nullable(),
	created_at: z.string(),
})

export const emailOutboundAttachmentsInputSchema = z
	.array(
		z.object({
			filename: z.string().min(1).max(255),
			content_type: z.string().min(1).max(255),
			content_base64: z.string().min(1),
		}),
	)
	.min(1)
	.max(maxOutboundEmailAttachments)
	.optional()

export function toOutboundEmailAttachments(
	attachments: z.infer<typeof emailOutboundAttachmentsInputSchema>,
) {
	return attachments?.map((attachment) => ({
		filename: attachment.filename,
		contentType: attachment.content_type,
		contentBase64: attachment.content_base64,
	}))
}

export const emailMessageDetailSchema = emailMessageSummarySchema.extend({
	cc_addresses: z.array(z.string()),
	bcc_addresses: z.array(z.string()),
	reply_to_addresses: z.array(z.string()),
	in_reply_to_header: z.string().nullable(),
	references: z.array(z.string()),
	headers: z.record(z.string(), z.unknown()).nullable(),
	auth_results: z.string().nullable(),
	text_body: z.string().nullable(),
	html_body: z.string().nullable(),
	raw_size: z.number().nullable(),
	attachments: z.array(emailAttachmentSchema),
})

export function stringArray(values: ReadonlyArray<unknown>) {
	return values.filter((value): value is string => typeof value === 'string')
}

export function toMessageSummary(message: EmailMessageRecord) {
	return {
		id: message.id,
		direction: message.direction,
		inbox_id: message.inboxId,
		thread_id: message.threadId,
		from_address: message.fromAddress,
		envelope_from: message.envelopeFrom,
		to_addresses: stringArray(message.toAddresses),
		subject: message.subject,
		message_id_header: message.messageIdHeader,
		processing_status: message.processingStatus,
		classification: message.classification,
		classification_reason: message.classificationReason,
		archived_at: message.archivedAt,
		provider_message_id: message.providerMessageId,
		delivery_status: message.deliveryStatus ?? null,
		delivery_status_at: message.deliveryStatusAt ?? null,
		error: message.error,
		received_at: message.receivedAt,
		sent_at: message.sentAt,
		created_at: message.createdAt,
		updated_at: message.updatedAt,
	}
}

export function toSenderRule(rule: EmailSenderRuleRecord) {
	return {
		id: rule.id,
		kind: rule.kind,
		value: rule.value,
		effect: rule.effect,
		note: rule.note,
		created_at: rule.createdAt,
		updated_at: rule.updatedAt,
	}
}

export function toMessageDetail(
	message: Parameters<typeof toMessageSummary>[0] & {
		ccAddresses: Array<unknown>
		bccAddresses: Array<unknown>
		replyToAddresses: Array<unknown>
		inReplyToHeader: string | null
		references: Array<unknown>
		headers: Record<string, unknown> | null
		authResults: string | null
		textBody: string | null
		htmlBody: string | null
		rawSize: number | null
	},
	attachments: Array<{
		id: string
		filename: string | null
		contentType: string | null
		contentId: string | null
		disposition: string | null
		size: number
		storageKind: string
		storageKey: string | null
		createdAt: string
	}>,
) {
	return {
		...toMessageSummary(message),
		cc_addresses: stringArray(message.ccAddresses),
		bcc_addresses: stringArray(message.bccAddresses),
		reply_to_addresses: stringArray(message.replyToAddresses),
		in_reply_to_header: message.inReplyToHeader,
		references: stringArray(message.references),
		headers: message.headers,
		auth_results: message.authResults,
		text_body: message.textBody,
		html_body: message.htmlBody,
		raw_size: message.rawSize,
		attachments: attachments.map((attachment) => ({
			id: attachment.id,
			filename: attachment.filename,
			content_type: attachment.contentType,
			content_id: attachment.contentId,
			disposition: attachment.disposition,
			size: attachment.size,
			storage_kind: attachment.storageKind,
			storage_key: attachment.storageKey,
			created_at: attachment.createdAt,
		})),
	}
}

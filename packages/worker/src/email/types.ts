import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	defaultEmailMessageView,
	emailClassificationValues,
	emailMessageViewValues,
	isEmailMessageView,
	manualEmailClassificationReason,
	type EmailClassification,
	type EmailMessageView,
} from '#universal/email-message-view.ts'

export const emailDirectionValues = ['inbound', 'outbound'] as const
export type EmailDirection = (typeof emailDirectionValues)[number]

export const emailProcessingStatusValues = ['stored', 'sent', 'failed'] as const
export type EmailProcessingStatus = (typeof emailProcessingStatusValues)[number]

export const emailDeliveryStatusValues = [
	'delivered',
	'deferred',
	'bounced',
	'failed',
	'rejected',
	'complained',
] as const
export type EmailDeliveryStatus = (typeof emailDeliveryStatusValues)[number]

export const emailDeliveryEventTypeValues = [
	'receive_started',
	'received',
	'rejected',
	'send_requested',
	'sent',
	'failed',
	'delivered',
	'deferred',
	'bounced',
	'complained',
] as const
export type EmailDeliveryEventType =
	(typeof emailDeliveryEventTypeValues)[number]

export {
	defaultEmailMessageView,
	emailClassificationValues,
	emailMessageViewValues,
	isEmailMessageView,
	manualEmailClassificationReason,
	type EmailClassification,
	type EmailMessageView,
}

/** Receive-time verdicts. `spam` is only ever set by a person or admin. */
export const emailReceiveClassificationValues = [
	'accepted',
	'quarantined',
] as const satisfies ReadonlyArray<EmailClassification>
export type EmailReceiveClassification =
	(typeof emailReceiveClassificationValues)[number]

/**
 * SQL predicates for a list view over a message table. Literal-only so the
 * Mailbox DO and the system D1 graph share one definition.
 */
export function emailMessageViewSqlClauses(
	view: EmailMessageView,
	columnPrefix = '',
): Array<string> {
	const classification = `${columnPrefix}classification`
	const archivedAt = `${columnPrefix}archived_at`
	switch (view) {
		case 'inbox':
			return [`${classification} <> 'spam'`, `${archivedAt} IS NULL`]
		case 'accepted':
			return [`${classification} = 'accepted'`, `${archivedAt} IS NULL`]
		case 'quarantined':
			return [`${classification} = 'quarantined'`, `${archivedAt} IS NULL`]
		case 'spam':
			return [`${classification} = 'spam'`]
		case 'archived':
			return [`${classification} <> 'spam'`, `${archivedAt} IS NOT NULL`]
		case 'all':
			return []
		default: {
			const exhaustive: never = view
			throw new Error(`Unhandled email message view: ${String(exhaustive)}`)
		}
	}
}

export const emailSenderRuleKindValues = ['address', 'domain'] as const
export type EmailSenderRuleKind = (typeof emailSenderRuleKindValues)[number]

export const emailSenderRuleEffectValues = [
	'allow',
	'block',
	'quarantine',
] as const
export type EmailSenderRuleEffect = (typeof emailSenderRuleEffectValues)[number]

export type EmailMailbox = {
	name: string | null
	address: string
}

export type EmailAttachmentMetadata = {
	filename: string | null
	contentType: string
	contentId: string | null
	disposition: string | null
	size: number
	storageKind?: 'raw-mime' | 'unavailable'
}

export type ParsedInboundEmail = {
	envelopeFrom: string
	envelopeTo: string
	headerFrom: string | null
	to: Array<EmailMailbox>
	cc: Array<EmailMailbox>
	bcc: Array<EmailMailbox>
	replyTo: Array<EmailMailbox>
	subject: string | null
	messageId: string | null
	inReplyTo: string | null
	references: Array<string>
	headers: Record<string, Array<string>>
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMime: string
	rawSize: number
	attachments: Array<EmailAttachmentMetadata>
}

export type EmailInboxRecord = {
	id: string
	userId: string
	packageId: string | null
	name: string
	description: string
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type EmailInboxAddressRecord = {
	id: string
	inboxId: string
	userId: string
	address: string
	localPart: string
	domain: string
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type EmailSenderIdentityRecord = {
	id: string
	userId: string
	email: string
	domain: string
	status: 'verified'
	verifiedAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailThreadRecord = {
	id: string
	userId: string
	inboxId: string | null
	subjectNormalized: string | null
	rootMessageIdHeader: string | null
	lastMessageAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailMessageRecord = {
	id: string
	direction: EmailDirection
	userId: OwnerId
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string | null
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string | null
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown> | null
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMimeKey: string | null
	rawSize: number | null
	processingStatus: EmailProcessingStatus
	classification: EmailClassification
	classificationReason: string | null
	/** Orthogonal to classification; archived mail leaves the default inbox. */
	archivedAt: string | null
	providerMessageId: string | null
	deliveryStatus: EmailDeliveryStatus | null
	deliveryStatusAt: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailSenderRuleRecord = {
	id: string
	userId: string
	kind: EmailSenderRuleKind
	value: string
	effect: EmailSenderRuleEffect
	note: string
	createdAt: string
	updatedAt: string
}

export type EmailAttachmentRecord = {
	id: string
	messageId: string
	filename: string | null
	contentType: string | null
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: string
	storageKey: string | null
	createdAt: string
}

export type EmailDeliveryEventRecord = {
	id: string
	messageId: string | null
	userId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string | null
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	createdAt: string
}

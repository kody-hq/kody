import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxDeliveryEventToEmailDeliveryEventRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'
import { loadEmailAttachmentContent, loadRawMime } from './service.ts'
import {
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageRecord,
	type EmailMessageView,
	type EmailProcessingStatus,
} from './types.ts'

export type OwnerEmailReaderEnv = MailboxEnv & {
	EMAIL_BLOBS?: R2Bucket
}

type OwnerReadBase = {
	env: OwnerEmailReaderEnv
	ownerId: OwnerId
}

function ownerMailbox(input: OwnerReadBase) {
	return mailboxRpc({ env: input.env, userId: input.ownerId })
}

export async function getOwnerEmailMessageById(
	input: OwnerReadBase & { messageId: string },
): Promise<EmailMessageRecord | null> {
	const message = await ownerMailbox(input).getMessage({
		messageId: input.messageId,
	})
	return message
		? mailboxMessageToEmailMessageRecord(message, input.ownerId)
		: null
}

export async function listOwnerEmailMessages(
	input: OwnerReadBase & {
		inboxId?: string | null
		direction?: EmailDirection | null
		processingStatus?: EmailProcessingStatus | null
		deliveryStatus?: EmailDeliveryStatus | null
		classification?: EmailClassification | null
		view?: EmailMessageView | null
		limit: number
	},
): Promise<Array<EmailMessageRecord>> {
	const listed = await ownerMailbox(input).listMessages({
		inboxId: input.inboxId,
		direction: input.direction,
		processingStatus: input.processingStatus,
		deliveryStatus: input.deliveryStatus,
		classification: input.classification,
		view: input.view,
		limit: input.limit,
	})
	return listed.messages.map((message) =>
		mailboxMessageToEmailMessageRecord(message, input.ownerId),
	)
}

export async function searchOwnerEmailMessages(
	input: OwnerReadBase & {
		query: string
		inboxId?: string | null
		direction?: EmailDirection | null
		processingStatus?: EmailProcessingStatus | null
		deliveryStatus?: EmailDeliveryStatus | null
		classification?: EmailClassification | null
		view?: EmailMessageView | null
		limit: number
	},
): Promise<Array<EmailMessageRecord>> {
	const searched = await ownerMailbox(input).searchMessages({
		query: input.query,
		inboxId: input.inboxId,
		direction: input.direction,
		processingStatus: input.processingStatus,
		deliveryStatus: input.deliveryStatus,
		classification: input.classification,
		view: input.view,
		limit: input.limit,
	})
	return searched.messages.map((message) =>
		mailboxMessageToEmailMessageRecord(message, input.ownerId),
	)
}

export async function listOwnerEmailMessagesPage(
	input: OwnerReadBase & {
		query: string
		view: EmailMessageView
		pageSize: number
		offset: number
	},
): Promise<{ total: number; messages: Array<EmailMessageRecord> }> {
	const mailbox = ownerMailbox(input)
	const filters = {
		view: input.view,
		query: input.query || null,
	}
	const [{ total }, listed] = await Promise.all([
		mailbox.countMessages(filters),
		input.query
			? mailbox.searchMessages({
					query: input.query,
					view: input.view,
					limit: input.pageSize,
					offset: input.offset,
				})
			: mailbox.listMessages({
					view: input.view,
					limit: input.pageSize,
					offset: input.offset,
				}),
	])
	return {
		total,
		messages: listed.messages.map((message) =>
			mailboxMessageToEmailMessageRecord(message, input.ownerId),
		),
	}
}

export async function listOwnerEmailAttachmentsForMessage(
	input: OwnerReadBase & { messageId: string },
): Promise<Array<EmailAttachmentRecord>> {
	const attachments = await ownerMailbox(input).listAttachmentsForMessage({
		messageId: input.messageId,
	})
	return attachments.map(mailboxAttachmentToEmailAttachmentRecord)
}

export async function getOwnerEmailAttachmentRecordById(
	input: OwnerReadBase & { attachmentId: string },
): Promise<EmailAttachmentRecord | null> {
	const attachment = await ownerMailbox(input).getAttachment({
		attachmentId: input.attachmentId,
	})
	return attachment
		? mailboxAttachmentToEmailAttachmentRecord(attachment)
		: null
}

export async function getOwnerEmailAttachmentById(
	input: OwnerReadBase & {
		blobs: R2Bucket
		attachmentId: string
	},
) {
	const attachment = await getOwnerEmailAttachmentRecordById(input)
	if (!attachment) return null
	const message = await getOwnerEmailMessageById({
		...input,
		messageId: attachment.messageId,
	})
	return loadEmailAttachmentContent({
		blobs: input.blobs,
		attachment,
		message,
	})
}

export async function listOwnerEmailDeliveryEvents(
	input: OwnerReadBase & {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit: number
	},
): Promise<Array<EmailDeliveryEventRecord>> {
	const events = await ownerMailbox(input).listDeliveryEvents({
		messageId: input.messageId,
		eventType: input.eventType,
		limit: input.limit,
	})
	return events.map((event) =>
		mailboxDeliveryEventToEmailDeliveryEventRecord(event, input.ownerId),
	)
}

export async function loadOwnerEmailRawMime(
	input: OwnerReadBase & {
		blobs: R2Bucket
		messageId: string
	},
): Promise<string | null> {
	const message = await getOwnerEmailMessageById(input)
	if (!message) return null
	return loadRawMime({ blobs: input.blobs, message })
}

export {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'

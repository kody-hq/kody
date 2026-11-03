import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isSystemEmailOwner } from './email-owner.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'
import type {
	MailboxBlobReferencePage,
	MailboxCountMessagesInput,
	MailboxCountResult,
	MailboxExportResult,
} from './mailbox-types.ts'
import {
	countSystemEmailMessages,
	getSystemEmailMessageById,
	listSystemEmailAttachments,
} from './system-email-graph-store.ts'
import type { EmailAttachmentRecord, EmailMessageRecord } from './types.ts'

/**
 * Internal product-reader chokepoint.
 *
 * USER metadata is authoritative in Mailbox and fails closed when its binding
 * or RPC is unavailable. The reserved `system:email` owner remains explicitly
 * D1-only. There is deliberately no feature flag or D1 fallback here.
 */
export type MailboxInternalReadEnv = MailboxEnv & {
	APP_DB: D1Database
}

function assertUserOwner(ownerId: OwnerId) {
	if (isSystemEmailOwner(ownerId)) {
		throw new Error('system:email has no Mailbox Durable Object.')
	}
}

export async function getInternalEmailMessageById(input: {
	env: MailboxInternalReadEnv
	ownerId: OwnerId
	messageId: string
}): Promise<EmailMessageRecord | null> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await getSystemEmailMessageById({
			db: input.env.APP_DB,
			messageId: input.messageId,
		})
	}
	const message = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).getMessage({ messageId: input.messageId })
	return message
		? mailboxMessageToEmailMessageRecord(message, input.ownerId)
		: null
}

export async function listInternalEmailAttachmentsForMessage(input: {
	env: MailboxInternalReadEnv
	ownerId: OwnerId
	messageId: string
}): Promise<Array<EmailAttachmentRecord>> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await listSystemEmailAttachments({
			db: input.env.APP_DB,
			messageId: input.messageId,
		})
	}
	const attachments = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).listAttachmentsForMessage({ messageId: input.messageId })
	return attachments.map(mailboxAttachmentToEmailAttachmentRecord)
}

export async function countInternalEmailMessages(input: {
	env: MailboxInternalReadEnv
	ownerId: OwnerId
}): Promise<number> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await countInternalSystemEmailMessages({ env: input.env })
	}
	return await countInternalUserEmailMessages(input)
}

export async function countInternalUserEmailMessages(input: {
	env: MailboxEnv
	ownerId: OwnerId
	/** Optional count filters (direction, classification, ...). */
	filters?: MailboxCountMessagesInput
}): Promise<number> {
	assertUserOwner(input.ownerId)
	const { total } = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).countMessages(input.filters ?? {})
	return total
}

export async function countInternalSystemEmailMessages(input: {
	env: { APP_DB: D1Database }
}): Promise<number> {
	return await countSystemEmailMessages({
		db: input.env.APP_DB,
	})
}

export async function exportInternalUserMailbox(input: {
	env: MailboxEnv
	ownerId: OwnerId
	pageSize?: number
	startAfter?: string | null
}): Promise<MailboxExportResult> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).exportMailbox({
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
}

export async function countInternalUserMailboxRows(input: {
	env: MailboxEnv
	ownerId: OwnerId
}): Promise<MailboxCountResult> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).countMailbox()
}

export async function listInternalUserEmailBlobReferences(input: {
	env: MailboxEnv
	ownerId: OwnerId
	pageSize?: number
	startAfter?: string | null
}): Promise<MailboxBlobReferencePage> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).listBlobReferences({
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
}

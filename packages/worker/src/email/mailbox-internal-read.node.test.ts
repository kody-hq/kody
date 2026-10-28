import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	countInternalEmailMessages,
	countInternalUserEmailMessages,
	exportInternalUserMailbox,
	getInternalEmailMessageById,
	listInternalEmailAttachmentsForMessage,
	listInternalUserEmailBlobReferences,
} from './mailbox-internal-read.ts'
import { type MailboxMessageRecord } from './mailbox-types.ts'

const {
	countSystemEmailMessagesMock,
	getSystemEmailMessageByIdMock,
	listSystemEmailAttachmentsMock,
} = vi.hoisted(() => ({
	countSystemEmailMessagesMock: vi.fn(),
	getSystemEmailMessageByIdMock: vi.fn(),
	listSystemEmailAttachmentsMock: vi.fn(),
}))

vi.mock('./system-email-graph-store.ts', () => ({
	countSystemEmailMessages: (...args: Array<unknown>) =>
		countSystemEmailMessagesMock(...args),
	getSystemEmailMessageById: (...args: Array<unknown>) =>
		getSystemEmailMessageByIdMock(...args),
	listSystemEmailAttachments: (...args: Array<unknown>) =>
		listSystemEmailAttachmentsMock(...args),
}))

function mailboxMessage(): MailboxMessageRecord {
	return {
		id: 'message-1',
		direction: 'inbound',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: 'sender@example.test',
		envelopeFrom: 'sender@example.test',
		toAddresses: ['owner@example.test'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Mailbox',
		messageIdHeader: '<message-1@example.test>',
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: 'body',
		htmlBody: null,
		rawMimeKey: 'email-raw:v1:user-a/message-1',
		rawSize: 4,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		archivedAt: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: '2026-08-02T00:00:00.000Z',
		sentAt: null,
		createdAt: '2026-08-02T00:00:00.000Z',
		updatedAt: '2026-08-02T00:00:00.000Z',
	}
}

function createEnv() {
	const attachment = {
		id: 'attachment-1',
		messageId: 'message-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 4,
		storageKind: 'external' as const,
		storageKey: 'email-attachment:v1:user-a/message-1/attachment-1',
		createdAt: '2026-08-02T00:00:00.000Z',
	}
	const rpc = {
		getMessage: vi.fn(async () => mailboxMessage()),
		listAttachmentsForMessage: vi.fn(async () => [attachment]),
		countMessages: vi.fn(async () => ({ total: 3 })),
		countMailbox: vi.fn(async () => ({
			threads: 1,
			messages: 3,
			attachments: 1,
			deliveryEvents: 2,
		})),
		exportMailbox: vi.fn(async () => ({
			rows: [],
			nextStartAfter: null,
			truncated: false,
		})),
		listBlobReferences: vi.fn(async () => ({
			references: [
				{
					kind: 'raw_mime' as const,
					key: 'email-raw:v1:user-a/message-1',
					messageId: 'message-1',
					attachmentId: null,
				},
			],
			nextStartAfter: null,
			truncated: false,
		})),
	}
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => rpc)
	return {
		env: {
			APP_DB: {} as D1Database,
			MAILBOX: { idFromName, get } as unknown as DurableObjectNamespace,
		},
		idFromName,
		rpc,
	}
}

test('internal reads route USER owners to Mailbox and system:email to the dedicated graph', async () => {
	const { env, idFromName, rpc } = createEnv()

	await expect(
		getInternalEmailMessageById({
			env,
			ownerId: ownerIdFromStored('user-a'),
			messageId: 'message-1',
		}),
	).resolves.toMatchObject({
		id: 'message-1',
		userId: ownerIdFromStored('user-a'),
		subject: 'Mailbox',
	})
	await expect(
		listInternalEmailAttachmentsForMessage({
			env,
			ownerId: ownerIdFromStored('user-a'),
			messageId: 'message-1',
		}),
	).resolves.toEqual([
		expect.objectContaining({ id: 'attachment-1', messageId: 'message-1' }),
	])
	await expect(
		countInternalEmailMessages({ env, ownerId: ownerIdFromStored('user-a') }),
	).resolves.toBe(3)
	await expect(
		countInternalUserEmailMessages({
			env: { MAILBOX: env.MAILBOX },
			ownerId: ownerIdFromStored('user-a'),
		}),
	).resolves.toBe(3)
	await expect(
		exportInternalUserMailbox({ env, ownerId: ownerIdFromStored('user-a') }),
	).resolves.toMatchObject({ rows: [], truncated: false })
	await expect(
		listInternalUserEmailBlobReferences({
			env,
			ownerId: ownerIdFromStored('user-a'),
		}),
	).resolves.toMatchObject({
		references: [
			expect.objectContaining({ key: 'email-raw:v1:user-a/message-1' }),
		],
	})

	expect(idFromName).toHaveBeenCalledWith('user-a')
	expect(rpc.getMessage).toHaveBeenCalledWith({ messageId: 'message-1' })
	expect(getSystemEmailMessageByIdMock).not.toHaveBeenCalled()
	expect(listSystemEmailAttachmentsMock).not.toHaveBeenCalled()
	expect(countSystemEmailMessagesMock).not.toHaveBeenCalled()

	const missingMailboxEnv = { APP_DB: {} as D1Database }
	await expect(
		getInternalEmailMessageById({
			env: missingMailboxEnv,
			ownerId: ownerIdFromStored('user-a'),
			messageId: 'message-1',
		}),
	).rejects.toThrow('MAILBOX Durable Object binding is not configured')
	await expect(
		countInternalEmailMessages({
			env: missingMailboxEnv,
			ownerId: ownerIdFromStored('user-a'),
		}),
	).rejects.toThrow('MAILBOX Durable Object binding is not configured')
	expect(getSystemEmailMessageByIdMock).not.toHaveBeenCalled()
	expect(countSystemEmailMessagesMock).not.toHaveBeenCalled()

	const d1Message = {
		...mailboxMessage(),
		userId: ownerIdFromStored('system:email'),
	}
	const attachment = {
		id: 'system-attachment',
		messageId: 'system-message',
	}
	getSystemEmailMessageByIdMock.mockResolvedValue(d1Message)
	listSystemEmailAttachmentsMock.mockResolvedValue([attachment])
	countSystemEmailMessagesMock.mockResolvedValue(7)

	await expect(
		getInternalEmailMessageById({
			env,
			ownerId: ownerIdFromStored('system:email'),
			messageId: 'system-message',
		}),
	).resolves.toBe(d1Message)
	await expect(
		listInternalEmailAttachmentsForMessage({
			env,
			ownerId: ownerIdFromStored('system:email'),
			messageId: 'system-message',
		}),
	).resolves.toEqual([attachment])
	await expect(
		countInternalEmailMessages({
			env,
			ownerId: ownerIdFromStored('system:email'),
		}),
	).resolves.toBe(7)
	await expect(
		exportInternalUserMailbox({
			env,
			ownerId: ownerIdFromStored('system:email'),
		}),
	).rejects.toThrow('system:email has no Mailbox')
	await expect(
		listInternalUserEmailBlobReferences({
			env,
			ownerId: ownerIdFromStored('system:email'),
		}),
	).rejects.toThrow('system:email has no Mailbox')

	expect(idFromName).not.toHaveBeenCalledWith('system:email')
	expect(getSystemEmailMessageByIdMock).toHaveBeenCalledWith({
		db: env.APP_DB,
		messageId: 'system-message',
	})
})

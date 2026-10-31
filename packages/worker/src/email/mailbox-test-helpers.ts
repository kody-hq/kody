import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { mailboxDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import { mailboxRpc } from './mailbox-client.ts'
import {
	type Mailbox,
	type MailboxAttachmentInput,
	type MailboxDeliveryEventInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-do.ts'

export function mailboxEnv(): { MAILBOX: DurableObjectNamespace<Mailbox> } {
	const mailbox = env.MAILBOX
	if (!mailbox) {
		throw new Error(
			'MAILBOX Durable Object binding is required for mailbox-do workers tests.',
		)
	}
	return { MAILBOX: mailbox }
}

export function stubFor(userId: OwnerId): DurableObjectStub<Mailbox> {
	const { MAILBOX } = mailboxEnv()
	return MAILBOX.get(MAILBOX.idFromName(mailboxDurableObjectName(userId)))
}

export function rpcFor(userId: OwnerId) {
	return mailboxRpc({ env: mailboxEnv(), userId })
}

export function uniqueUserId(label: string): OwnerId {
	return ownerIdFromStored(`mailbox-${label}-${crypto.randomUUID()}`)
}

export async function assertMailboxThrows(
	pattern: RegExp,
	run: () => Promise<unknown>,
) {
	try {
		await run()
		throw new Error(`Expected mailbox RPC to throw matching ${pattern}`)
	} catch (error) {
		expect(String(error)).toMatch(pattern)
	}
}

/** Complete thread snapshot; overrides may be Partial. */
export function baseThread(
	overrides?: Partial<MailboxThreadInput>,
): MailboxThreadInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.lastMessageAt ?? '2026-07-01T12:00:00.000Z'
	const defaults: MailboxThreadInput = {
		id,
		inboxId: 'inbox-1',
		subjectNormalized: 'hello',
		rootMessageIdHeader: `<root-${id}@example.com>`,
		lastMessageAt: at,
		createdAt: at,
		updatedAt: at,
	}
	return { ...defaults, ...overrides, id: overrides?.id ?? id }
}

/** Complete message snapshot; overrides may be Partial. */
export function baseMessage(
	ownerId: OwnerId,
	overrides?: Partial<MailboxMessageInput>,
): MailboxMessageInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.createdAt ?? '2026-07-01T12:00:00.000Z'
	const direction = overrides?.direction ?? 'inbound'
	const rawMimeKey =
		overrides?.rawMimeKey !== undefined
			? overrides.rawMimeKey
			: direction === 'outbound'
				? null
				: emailRawMimeKey(ownerId, id)
	const defaults: MailboxMessageInput = {
		id,
		direction,
		inboxId: 'inbox-1',
		threadId: null,
		senderIdentityId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: 'envelope@example.com',
		toAddresses: ['owner@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Hello mailbox',
		messageIdHeader: `<msg-${id}@example.com>`,
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: null,
		htmlBody: null,
		rawMimeKey,
		rawSize: 128,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		archivedAt: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: at,
		sentAt: null,
		createdAt: at,
		updatedAt: at,
	}
	return {
		...defaults,
		...overrides,
		id,
		direction,
		rawMimeKey,
	}
}

/** Complete attachment snapshot; overrides may be Partial. */
export function baseAttachment(
	ownerId: OwnerId,
	messageId: string,
	overrides?: Partial<MailboxAttachmentInput>,
): MailboxAttachmentInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const storageKind = overrides?.storageKind ?? 'external'
	const storageKey =
		overrides?.storageKey !== undefined
			? overrides.storageKey
			: storageKind === 'external'
				? emailAttachmentBlobKey(ownerId, messageId, id)
				: null
	const defaults: MailboxAttachmentInput = {
		id,
		messageId,
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: null,
		size: 12,
		storageKind,
		storageKey,
		createdAt: '2026-07-01T12:00:00.000Z',
	}
	return {
		...defaults,
		...overrides,
		id,
		messageId,
		storageKind,
		storageKey,
	}
}

/** Complete delivery-event snapshot; overrides may be Partial. */
export function baseDeliveryEvent(
	overrides?: Partial<MailboxDeliveryEventInput>,
): MailboxDeliveryEventInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.createdAt ?? '2026-07-02T10:00:00.000Z'
	const defaults: MailboxDeliveryEventInput = {
		id,
		messageId: null,
		inboxId: null,
		eventType: 'received',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: null,
		detailJson: '{}',
		needsEffectReconcile: false,
		state: null,
		fingerprint: null,
		storageLease: null,
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: null,
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: null,
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: at,
		updatedAt: at,
	}
	return { ...defaults, ...overrides, id: overrides?.id ?? id }
}

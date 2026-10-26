import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import { loadPostalMime } from '#worker/postal-mime-load.ts'
import {
	putEmailRawMime,
	RetryableInboundStorageError,
} from './email-raw-mime-store.ts'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { type InboundDelivery } from './inbound-delivery.ts'
import { type UserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import { mailboxMessageToEmailMessageRecord } from './mailbox-record-mappers.ts'
import {
	deleteOutboundProviderIndexByMessageId,
	getOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { recordBoundedSystemEmailRejection } from './system-inbound-delivery-store.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { assertUserEmailGraphAuthority } from './user-email-graph-authority.ts'
import { recordDeliveryAlertEvent } from './delivery-alert-events.ts'
import {
	getSystemEmailAttachmentById,
	getSystemEmailMessageById,
	listSystemEmailAttachments,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import {
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDeliveryStatus,
	type EmailMessageRecord,
	type ParsedInboundEmail,
} from './types.ts'

export { RetryableInboundStorageError }

function nowIso() {
	return new Date().toISOString()
}

/**
 * Resolve a message's raw MIME from EMAIL_BLOBS via `raw_mime_key`.
 * Returns null when the message has no key or the blob is unreachable.
 */
export async function loadRawMime(input: {
	blobs: R2Bucket
	message: Pick<EmailMessageRecord, 'rawMimeKey'>
}): Promise<string | null> {
	const key = input.message.rawMimeKey
	if (!key) return null
	const object = await input.blobs.get(key)
	if (!object) return null
	return await object.text()
}

export async function getEmailMessageWithAttachmentsById(input: {
	env: MailboxEnv
	db: D1Database
	userId: OwnerId
	messageId: string
}) {
	const message =
		input.userId === systemEmailOwnerId
			? await getSystemEmailMessageById({
					db: input.db,
					messageId: input.messageId,
				})
			: await mailboxRpc({
					env: input.env,
					userId: input.userId,
				})
					.getMessage({ messageId: input.messageId })
					.then((record) =>
						record
							? mailboxMessageToEmailMessageRecord(record, input.userId)
							: null,
					)
	if (!message) return null
	const attachments =
		input.userId === systemEmailOwnerId
			? await listSystemEmailAttachments({
					db: input.db,
					messageId: message.id,
				})
			: await mailboxRpc({
					env: input.env,
					userId: input.userId,
				})
					.listAttachmentsForMessage({ messageId: message.id })
					.then((records) => records.map((record) => ({ ...record })))
	return {
		message,
		attachments,
	}
}

export async function storeIdempotentInboundEmail(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	parsed: ParsedInboundEmail
	subjectNormalized: string
	now: string
	authority: Pick<
		UserInboundDeliveryAuthority,
		| 'commitInboundMessageGraph'
		| 'findThreadForInboundMessage'
		| 'get'
		| 'receive'
	>
}) {
	const { delivery, parsed } = input
	if (delivery.userId === systemEmailOwnerId) {
		throw new Error(
			'System inbound storage must use the dedicated system email service.',
		)
	}
	if (!delivery.storageLease) {
		throw new RetryableInboundStorageError(
			'Inbound delivery storage requires an active lease.',
		)
	}
	await putEmailRawMime({
		blobs: input.blobs,
		userId: delivery.userId,
		messageId: delivery.messageId,
		rawMime: parsed.rawMime,
	})

	const existingThread = await input.authority.findThreadForInboundMessage({
		inboxId: delivery.inboxId,
		references: parsed.references,
		inReplyToHeader: parsed.inReplyTo,
	})
	const threadId = existingThread?.id ?? delivery.threadId
	const thread = existingThread
		? {
				...existingThread,
				lastMessageAt:
					existingThread.lastMessageAt > input.now
						? existingThread.lastMessageAt
						: input.now,
				updatedAt: input.now,
			}
		: {
				id: threadId,
				inboxId: delivery.inboxId,
				subjectNormalized: input.subjectNormalized,
				rootMessageIdHeader: parsed.messageId,
				lastMessageAt: input.now,
				createdAt: input.now,
				updatedAt: input.now,
			}
	const { classification, classificationReason } =
		await resolveInboundEmailClassification({
			db: input.db,
			userId: delivery.userId,
			fromAddress: parsed.headerFrom,
			envelopeFrom: parsed.envelopeFrom,
			authResults: parsed.authResults,
		})
	const message = {
		id: delivery.messageId,
		direction: 'inbound' as const,
		inboxId: delivery.inboxId,
		threadId,
		senderIdentityId: null,
		fromAddress: parsed.headerFrom ?? parsed.envelopeFrom,
		envelopeFrom: parsed.envelopeFrom,
		toAddresses: parsed.to.map((entry) => entry.address),
		ccAddresses: parsed.cc.map((entry) => entry.address),
		bccAddresses: parsed.bcc.map((entry) => entry.address),
		replyToAddresses: parsed.replyTo.map((entry) => entry.address),
		subject: parsed.subject ?? '',
		messageIdHeader: parsed.messageId,
		inReplyToHeader: parsed.inReplyTo,
		references: parsed.references,
		headers: parsed.headers,
		authResults: parsed.authResults,
		textBody: parsed.textBody,
		htmlBody: parsed.htmlBody,
		rawMimeKey: delivery.rawMimeKey,
		rawSize: parsed.rawSize,
		processingStatus: 'stored' as const,
		classification,
		classificationReason,
		archivedAt: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: input.now,
		sentAt: null,
		createdAt: input.now,
		updatedAt: input.now,
	}
	const attachments = parsed.attachments.map((attachment, index) => ({
		id: `${delivery.messageId}:attachment:${index}`,
		messageId: delivery.messageId,
		filename: attachment.filename,
		contentType: attachment.contentType,
		contentId: attachment.contentId,
		disposition: attachment.disposition,
		size: attachment.size,
		storageKind: attachment.storageKind ?? 'raw-mime',
		storageKey: null,
		createdAt: input.now,
	}))
	let committed
	try {
		committed = await input.authority.commitInboundMessageGraph({
			delivery,
			thread,
			message,
			attachments,
		})
	} catch (error) {
		throw new RetryableInboundStorageError(
			'Failed to atomically commit the inbound Mailbox graph; the stable delivery will be retried.',
			error,
		)
	}
	if (committed.status === 'lease-lost') {
		throw new RetryableInboundStorageError(
			'Inbound Mailbox graph commit lost its storage lease; the stable delivery will be retried.',
		)
	}
	const stored = mailboxMessageToEmailMessageRecord(
		committed.message,
		delivery.userId,
	)

	const authority = input.authority
	if (!authority) {
		throw new Error('User inbound finalization requires Mailbox authority.')
	}
	let finalizedDelivery: InboundDelivery
	try {
		const finalization = {
			delivery,
			usageDurationMs: delivery.usageStartedAt
				? Date.now() - Date.parse(delivery.usageStartedAt)
				: 0,
			usageMonth: (stored.receivedAt ?? stored.createdAt).slice(0, 7),
			usageBytes: stored.rawSize ?? 0,
		}
		finalizedDelivery = await authority.receive(finalization)
	} catch (error) {
		const committed = await authority.get(delivery.deliveryId).catch(() => null)
		if (committed?.state !== 'received') {
			throw new RetryableInboundStorageError(
				'Failed to finalize the inbound delivery ledger; the stable delivery will be retried.',
				error,
			)
		}
		finalizedDelivery = committed
	}
	return {
		message: stored,
		finalizedDelivery,
		wonFinalization:
			finalizedDelivery.finalizationToken === delivery.storageLease,
	}
}

/**
 * Load attachment bytes after metadata selection. External attachments use
 * `EMAIL_BLOBS` via `storageKey`; raw-mime attachments parse the message's
 * raw MIME blob. Metadata comes from Mailbox or the dedicated system graph.
 */
export async function loadEmailAttachmentContent(input: {
	blobs: R2Bucket
	attachment: EmailAttachmentRecord
	message: Pick<EmailMessageRecord, 'rawMimeKey'> | null
}) {
	const { attachment } = input
	// Externally stored attachments (outbound mail) keep their bytes in a
	// dedicated R2 object instead of inside raw MIME.
	if (attachment.storageKind === 'external') {
		const object = attachment.storageKey
			? await input.blobs.get(attachment.storageKey)
			: null
		if (!object) {
			return { ...attachment, content: null, contentBase64: null }
		}
		const buffer = await object.arrayBuffer()
		return {
			...attachment,
			content: buffer,
			contentBase64: bytesToBase64(new Uint8Array(buffer)),
		}
	}
	if (attachment.storageKind === 'unavailable') {
		return { ...attachment, content: null, contentBase64: null }
	}
	const rawMime = input.message
		? await loadRawMime({ blobs: input.blobs, message: input.message })
		: null
	if (!rawMime) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const PostalMime = await loadPostalMime()
	const parsed = await PostalMime.parse(rawMime, {
		attachmentEncoding: 'arraybuffer',
	})
	const matched = parsed.attachments.find((candidate) => {
		if ((candidate.filename ?? null) !== attachment.filename) return false
		if (candidate.mimeType !== (attachment.contentType ?? candidate.mimeType)) {
			return false
		}
		if ((candidate.contentId ?? null) !== attachment.contentId) return false
		if ((candidate.disposition ?? null) !== attachment.disposition) return false
		const content = candidate.content
		const size =
			typeof content === 'string'
				? new TextEncoder().encode(content).byteLength
				: content.byteLength
		return size === attachment.size
	})
	if (!matched) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const bytes =
		typeof matched.content === 'string'
			? new TextEncoder().encode(matched.content)
			: new Uint8Array(matched.content)
	return {
		...attachment,
		content: matched.content,
		contentBase64: bytesToBase64(bytes),
	}
}

export async function getEmailAttachmentById(input: {
	env: MailboxEnv
	db: D1Database
	/** EMAIL_BLOBS bucket for messages whose raw MIME lives in R2. */
	blobs: R2Bucket
	userId: OwnerId
	attachmentId: string
}) {
	const attachment =
		input.userId === systemEmailOwnerId
			? await getSystemEmailAttachmentById({
					db: input.db,
					attachmentId: input.attachmentId,
				})
			: await mailboxRpc({
					env: input.env,
					userId: input.userId,
				})
					.getAttachment({ attachmentId: input.attachmentId })
					.then((record) => (record ? { ...record } : null))
	if (!attachment) return null
	const message =
		input.userId === systemEmailOwnerId
			? await getSystemEmailMessageById({
					db: input.db,
					messageId: attachment.messageId,
				})
			: await mailboxRpc({
					env: input.env,
					userId: input.userId,
				})
					.getMessage({ messageId: attachment.messageId })
					.then((record) =>
						record
							? mailboxMessageToEmailMessageRecord(record, input.userId)
							: null,
					)
	return loadEmailAttachmentContent({
		blobs: input.blobs,
		attachment,
		message,
	})
}

/**
 * How many quota/size/verification rejections per inbox per UTC day get
 * their own delivery-event row before collapsing into the daily aggregate
 * row.
 */
export const maxDetailedEmailRejectionEventsPerDay = 5

/**
 * Record an entitlement/size/verification rejection without unbounded row
 * growth. Every rejection upserts one aggregate 'rejected' event per inbox
 * per UTC day (deterministic id, counter in detail_json), and only the
 * first `maxDetailedEmailRejectionEventsPerDay` attempts of the day also
 * store an individual detailed event. This traffic is attacker-controlled
 * and not limited by the daily receive counter (over-quota mail has
 * already exhausted it; unverified-account mail never consumes it), so
 * without this cap a flood of rejected mail would grow D1 one row per
 * attempt — the denial-of-wallet shape the quotas exist to prevent.
 */
export async function recordBoundedEmailRejectionEvent(input: {
	env: MailboxEnv
	db: D1Database
	userId: OwnerId
	inboxId: string
	recipient: string
	reason: string
	phase:
		| 'entitlement'
		| 'size'
		| 'account-verification'
		| 'account-suspension'
		| 'account-plan'
		| 'sender-policy'
		| 'system-limit'
	now?: Date
}) {
	const now = input.now ?? new Date()
	if (input.userId === systemEmailOwnerId) {
		return await recordBoundedSystemEmailRejection({
			db: input.db,
			inboxId: input.inboxId,
			recipient: input.recipient,
			reason: input.reason,
			phase: input.phase,
			now,
			detailLimit: maxDetailedEmailRejectionEventsPerDay,
		})
	}
	const nowIsoString = now.toISOString()
	const day = isoTimestampDayKey(nowIsoString)
	const result = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).recordBoundedRejection({
		ownerId: input.userId,
		inboxId: input.inboxId,
		recipient: input.recipient,
		reason: input.reason,
		phase: input.phase,
		day,
		now: nowIsoString,
		detailLimit: maxDetailedEmailRejectionEventsPerDay,
		detailEventId: crypto.randomUUID(),
	})
	return result.count
}

/**
 * Reclassify and/or archive a stored message in its authoritative graph.
 * `archived: true` stamps `archived_at`, `false` clears it, omitted keeps it.
 * Returns false when the message is missing (or a newer write won).
 */
export async function setEmailMessageClassification(input: {
	env: MailboxEnv
	db: D1Database
	userId: OwnerId
	messageId: string
	classification?: EmailClassification
	classificationReason?: string | null
	archived?: boolean
	now?: string
}) {
	if (input.classification === undefined && input.archived === undefined) {
		throw new Error('Email message update requires classification or archived.')
	}
	const now = input.now ?? nowIso()
	if (input.userId === systemEmailOwnerId) {
		return await updateSystemEmailMessageClassification({
			db: input.db,
			messageId: input.messageId,
			classification: input.classification,
			classificationReason: input.classificationReason,
			archived: input.archived,
			now,
		})
	}
	await assertUserEmailGraphAuthority({
		db: input.db,
		ownerId: input.userId,
	})
	const result = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).setMessageClassification({
		ownerId: input.userId,
		messageId: input.messageId,
		...(input.classification === undefined
			? {}
			: {
					classification: input.classification,
					classificationReason: input.classificationReason ?? null,
				}),
		...(input.archived === undefined
			? {}
			: { archivedAt: input.archived ? now : null }),
		updatedAt: now,
	})
	return result.status === 'accepted'
}

/**
 * Delete one stored user-mailbox message (metadata + canonical blobs) owned by
 * `userId`. Missing and foreign ids are indistinguishable from the owner's
 * Mailbox and return false. System-inbox rows are not on this path.
 */
export async function deleteEmailMessage(input: {
	env: MailboxEnv
	db: D1Database
	userId: OwnerId
	messageId: string
}) {
	if (input.userId === systemEmailOwnerId) {
		throw new Error(
			'System inbox messages cannot be deleted through the user email store.',
		)
	}
	await assertUserEmailGraphAuthority({
		db: input.db,
		ownerId: input.userId,
	})
	const result = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).deleteMessageWithBlobs({
		ownerId: input.userId,
		messageId: input.messageId,
	})
	if (result.status === 'missing') {
		return false
	}
	await deleteOutboundProviderIndexByMessageId({
		db: input.db,
		messageId: input.messageId,
	})
	return true
}

/**
 * Record a Cloudflare outbound delivery lifecycle event. Resolution is
 * index-first via `email_outbound_provider_index`, then an owner Mailbox point
 * read — never a shared-graph scan.
 */
export async function recordProviderEmailDeliveryEvent(input: {
	env: MailboxEnv & { APP_DB: D1Database }
	reportingEnv?: EmailReportingEnv
	providerMessageId: string
	providerEventId: string
	deliveryStatus: EmailDeliveryStatus
	eventTimestamp: string
	detail: Record<string, unknown>
}) {
	const db = input.env.APP_DB
	const index = await getOutboundProviderIndexRow({
		db,
		providerMessageId: input.providerMessageId,
	})
	if (!index) {
		return { outcome: 'unmatched' as const, message: null }
	}
	await assertUserEmailGraphAuthority({
		db,
		ownerId: index.userId,
	})
	const mailbox = mailboxRpc({ env: input.env, userId: index.userId })
	const current = await mailbox.getMessage({ messageId: index.messageId })
	if (!current || current.direction !== 'outbound') {
		return { outcome: 'unmatched' as const, message: null }
	}
	if (
		input.deliveryStatus === 'bounced' ||
		input.deliveryStatus === 'complained'
	) {
		await recordDeliveryAlertEvent({
			db,
			providerEventId: input.providerEventId,
			provider: 'cloudflare-email',
			eventType: input.deliveryStatus,
			occurredAt: input.eventTimestamp,
		})
	}
	const message = mailboxMessageToEmailMessageRecord(current, index.userId)
	const existing = await mailbox.getDeliveryEventByProviderEventId({
		providerEventId: input.providerEventId,
	})
	if (existing) {
		const duplicateIsCurrent =
			existing.eventType === input.deliveryStatus &&
			existing.providerMessageId === input.providerMessageId
		return {
			outcome: duplicateIsCurrent ? ('duplicate' as const) : ('stale' as const),
			message,
		}
	}
	const eventId = crypto.randomUUID()
	const updatedAt = nowIso()
	const write = await mailbox.upsertDeliveryEvent({
		ownerId: index.userId,
		event: {
			id: eventId,
			messageId: index.messageId,
			inboxId: index.inboxId,
			eventType: input.deliveryStatus,
			provider: 'cloudflare-email',
			providerMessageId: input.providerMessageId,
			providerEventId: input.providerEventId,
			detailJson: JSON.stringify(input.detail),
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
			createdAt: input.eventTimestamp,
			updatedAt,
		},
		latestDeliveryStatus: {
			messageId: index.messageId,
			deliveryStatus: input.deliveryStatus,
			deliveryStatusAt: input.eventTimestamp,
		},
	})
	if (!write.inserted) {
		return { outcome: 'duplicate' as const, message }
	}
	if (input.reportingEnv) {
		recordEmailReportingEvent(input.reportingEnv, {
			userId: index.userId,
			eventType: 'email_delivery',
			outcome: input.deliveryStatus,
			timestamp: input.eventTimestamp,
		})
	}
	if (!write.updatedLatestStatus) {
		return { outcome: 'stale' as const, message }
	}

	const updatedMessageRecord = await mailbox.getMessage({
		messageId: index.messageId,
	})
	const updatedMessage = updatedMessageRecord
		? mailboxMessageToEmailMessageRecord(updatedMessageRecord, index.userId)
		: null
	if (!updatedMessage) {
		throw new Error(
			`Email message disappeared after delivery event: ${message.id}`,
		)
	}
	return {
		outcome: 'recorded' as const,
		message: updatedMessage,
		event: {
			id: eventId,
			messageId: message.id,
			userId: index.userId,
			inboxId: index.inboxId,
			eventType: input.deliveryStatus,
			provider: 'cloudflare-email',
			providerMessageId: input.providerMessageId,
			providerEventId: input.providerEventId,
			detailJson: JSON.stringify(input.detail),
			createdAt: input.eventTimestamp,
		} satisfies EmailDeliveryEventRecord,
	}
}

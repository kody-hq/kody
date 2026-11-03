import { systemEmailOwnerId } from './email-owner.ts'
import {
	putEmailRawMime,
	RetryableInboundStorageError,
} from './email-raw-mime-store.ts'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import type { InboundDelivery } from './inbound-delivery.ts'
import {
	getSystemInboundDelivery,
	markSystemInboundDeliveryReceived,
} from './system-inbound-delivery-store.ts'
import {
	createSystemEmailThread,
	findSystemEmailThreadForInboundMessage,
	getSystemEmailMessageById,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailAttachments,
	touchSystemEmailThread,
} from './system-email-graph-store.ts'
import type { ParsedInboundEmail } from './types.ts'

export async function storeIdempotentSystemInboundEmail(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: Omit<InboundDelivery, 'userId'>
	parsed: ParsedInboundEmail
	subjectNormalized: string
	now: string
}) {
	const delivery: InboundDelivery = {
		...input.delivery,
		userId: systemEmailOwnerId,
	}
	const { parsed } = input
	if (!delivery.storageLease) {
		throw new RetryableInboundStorageError(
			'Inbound delivery storage requires an active lease.',
		)
	}
	const inboundDeliveryFence = {
		deliveryId: delivery.deliveryId,
		storageLease: delivery.storageLease,
	}
	await putEmailRawMime({
		blobs: input.blobs,
		userId: systemEmailOwnerId,
		messageId: delivery.messageId,
		rawMime: parsed.rawMime,
	})

	let stored = await getSystemEmailMessageById({
		db: input.db,
		messageId: delivery.messageId,
	})
	if (!stored) {
		let thread = await findSystemEmailThreadForInboundMessage({
			db: input.db,
			inboxId: delivery.inboxId,
			references: parsed.references,
			inReplyToHeader: parsed.inReplyTo,
		})
		if (!thread) {
			thread = await createSystemEmailThread({
				db: input.db,
				id: delivery.threadId,
				inboxId: delivery.inboxId,
				subjectNormalized: input.subjectNormalized,
				rootMessageIdHeader: parsed.messageId,
				lastMessageAt: input.now,
				ignoreConflict: true,
				inboundDeliveryFence,
			})
		}
		const { classification, classificationReason } =
			await resolveInboundEmailClassification({
				db: input.db,
				userId: systemEmailOwnerId,
				fromAddress: parsed.headerFrom,
				envelopeFrom: parsed.envelopeFrom,
				authResults: parsed.authResults,
			})
		try {
			stored = await insertSystemEmailMessage({
				db: input.db,
				inboundDeliveryFence,
				message: {
					id: delivery.messageId,
					inboxId: delivery.inboxId,
					threadId: thread.id,
					senderIdentityId: null,
					fromAddress: parsed.headerFrom,
					envelopeFrom: parsed.envelopeFrom,
					toAddresses: parsed.to.map((entry) => entry.address),
					ccAddresses: parsed.cc.map((entry) => entry.address),
					bccAddresses: parsed.bcc.map((entry) => entry.address),
					replyToAddresses: parsed.replyTo.map((entry) => entry.address),
					subject: parsed.subject,
					messageIdHeader: parsed.messageId,
					inReplyToHeader: parsed.inReplyTo,
					references: parsed.references,
					headers: parsed.headers,
					authResults: parsed.authResults,
					textBody: parsed.textBody,
					htmlBody: parsed.htmlBody,
					rawMimeKey: delivery.rawMimeKey,
					rawSize: parsed.rawSize,
					processingStatus: 'stored',
					classification,
					classificationReason,
					error: null,
					receivedAt: input.now,
					sentAt: null,
				},
			})
		} catch (error) {
			stored = await getSystemEmailMessageById({
				db: input.db,
				messageId: delivery.messageId,
			}).catch(() => null)
			if (!stored) {
				throw new RetryableInboundStorageError(
					'Failed to commit inbound email message; the stable delivery will be retried.',
					error,
				)
			}
		}
	}

	let storedAttachments:
		| Awaited<ReturnType<typeof listSystemEmailAttachments>>
		| null
		| undefined
	try {
		await insertSystemEmailAttachments({
			db: input.db,
			messageId: delivery.messageId,
			ignoreConflicts: true,
			inboundDeliveryFence,
			attachments: parsed.attachments.map((attachment, index) => ({
				id: `${delivery.messageId}:attachment:${index}`,
				filename: attachment.filename,
				contentType: attachment.contentType,
				contentId: attachment.contentId,
				disposition: attachment.disposition,
				size: attachment.size,
				storageKind: attachment.storageKind ?? 'raw-mime',
				storageKey: null,
			})),
		})
	} catch (error) {
		storedAttachments = await listSystemEmailAttachments({
			db: input.db,
			messageId: delivery.messageId,
		}).catch(() => null)
		if (storedAttachments?.length !== parsed.attachments.length) {
			throw new RetryableInboundStorageError(
				'Failed to commit inbound email attachments; the stable delivery will be retried.',
				error,
			)
		}
	}
	storedAttachments ??= await listSystemEmailAttachments({
		db: input.db,
		messageId: delivery.messageId,
	}).catch((error: unknown) => {
		throw new RetryableInboundStorageError(
			'Failed to verify inbound email attachments; the stable delivery will be retried.',
			error,
		)
	})
	if (storedAttachments.length !== parsed.attachments.length) {
		throw new RetryableInboundStorageError(
			'Inbound email attachment commit was incomplete; the stable delivery will be retried.',
		)
	}

	const finalization = {
		delivery,
		usageDurationMs: delivery.usageStartedAt
			? Date.now() - Date.parse(delivery.usageStartedAt)
			: 0,
		usageMonth: (stored.receivedAt ?? stored.createdAt).slice(0, 7),
		usageBytes: stored.rawSize ?? 0,
	}
	let finalizedDelivery: InboundDelivery
	try {
		finalizedDelivery = await markSystemInboundDeliveryReceived({
			db: input.db,
			...finalization,
		})
	} catch (error) {
		const committed = await getSystemInboundDelivery({
			db: input.db,
			deliveryId: delivery.deliveryId,
		}).catch(() => null)
		if (committed?.state !== 'received') {
			throw new RetryableInboundStorageError(
				'Failed to finalize the inbound delivery ledger; the stable delivery will be retried.',
				error,
			)
		}
		finalizedDelivery = committed
	}
	try {
		if (stored.threadId) {
			await touchSystemEmailThread({
				db: input.db,
				threadId: stored.threadId,
				lastMessageAt: input.now,
			})
		}
	} catch (error) {
		console.error(
			'inbound-email-post-commit-bookkeeping-failed',
			stored.id,
			error,
		)
	}
	return {
		message: stored,
		finalizedDelivery,
		wonFinalization:
			finalizedDelivery.finalizationToken === delivery.storageLease,
	}
}

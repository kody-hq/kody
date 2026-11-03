import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { insertInput } from './mailbox-inbound-ledger-test-helpers.ts'
import {
	assertMailboxThrows,
	baseAttachment,
	baseMessage,
	baseThread,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'
import type { Mailbox } from './mailbox-do.ts'

test('inbound graph commit atomically fences the active storage lease', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('inbound-graph')
	const mailbox = rpcFor(ownerId)
	const now = '2026-08-03T05:00:00.000Z'
	const delivery = insertInput(ownerId, {
		deliveryId: `delivery-${crypto.randomUUID()}`,
		messageId: `message-${crypto.randomUUID()}`,
		threadId: `thread-${crypto.randomUUID()}`,
		inboxId: `inbox-${crypto.randomUUID()}`,
	})
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId,
		delivery,
		now,
	})
	const claim = await mailbox.claimInboundDeliveryStorage({
		ownerId,
		deliveryId: delivery.deliveryId,
		expectedAttachmentCount: 1,
		now,
	})
	expect(claim.status).toBe('claimed')
	if (claim.status !== 'claimed') throw new Error('expected storage claim')
	const storageLease = claim.delivery.storageLease
	if (!storageLease) throw new Error('expected storage lease')

	const thread = baseThread({
		id: delivery.threadId,
		inboxId: delivery.inboxId,
		createdAt: now,
		updatedAt: now,
		lastMessageAt: now,
	})
	const message = baseMessage(ownerId, {
		id: delivery.messageId,
		inboxId: delivery.inboxId,
		threadId: thread.id,
		createdAt: now,
		updatedAt: now,
		receivedAt: now,
	})
	const attachment = baseAttachment(ownerId, message.id, {
		id: `attachment-${crypto.randomUUID()}`,
		storageKind: 'raw-mime',
		createdAt: now,
	})

	await expect(
		mailbox.commitInboundMessageGraph({
			ownerId,
			deliveryId: delivery.deliveryId,
			storageLease: 'stale-lease',
			thread,
			message,
			attachments: [attachment],
		}),
	).resolves.toEqual({ status: 'lease-lost' })
	expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()
	expect(await mailbox.getThread({ threadId: thread.id })).toBeNull()

	await runInDurableObject(stubFor(ownerId), async (instance: Mailbox) => {
		await assertMailboxThrows(/attachment\.messageId must match/, () =>
			instance.commitInboundMessageGraph({
				ownerId,
				deliveryId: delivery.deliveryId,
				storageLease,
				thread,
				message,
				attachments: [{ ...attachment, messageId: 'wrong-message' }],
			}),
		)
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()
	expect(await mailbox.getThread({ threadId: thread.id })).toBeNull()

	await expect(
		mailbox.commitInboundMessageGraph({
			ownerId,
			deliveryId: delivery.deliveryId,
			storageLease,
			thread,
			message,
			attachments: [attachment],
		}),
	).resolves.toMatchObject({
		status: 'committed',
		message: { id: message.id, threadId: thread.id },
	})
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: message.id }),
	).toEqual([
		expect.objectContaining({ id: attachment.id, storageKind: 'raw-mime' }),
	])
	expect(
		await mailbox.getInboundDelivery({
			ownerId,
			deliveryId: delivery.deliveryId,
		}),
	).toMatchObject({ state: 'storing', storageLease })

	await expect(
		mailbox.markInboundDeliveryReceived({
			ownerId,
			deliveryId: delivery.deliveryId,
			storageLease,
			usageDurationMs: 10,
			usageMonth: '2026-08',
			usageBytes: message.rawSize ?? 0,
			now: '2026-08-03T05:00:01.000Z',
		}),
	).resolves.toMatchObject({ status: 'received' })
	await expect(
		mailbox.commitInboundMessageGraph({
			ownerId,
			deliveryId: delivery.deliveryId,
			storageLease,
			thread,
			message,
			attachments: [attachment],
		}),
	).resolves.toMatchObject({ status: 'already-committed' })
	await expect(
		mailbox.commitInboundMessageGraph({
			ownerId,
			deliveryId: delivery.deliveryId,
			storageLease: 'forged-retry-lease',
			thread,
			message,
			attachments: [attachment],
		}),
	).resolves.toEqual({ status: 'lease-lost' })
}, 30_000)

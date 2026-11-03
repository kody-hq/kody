import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import type { Mailbox } from './mailbox-do.ts'
import {
	assertMailboxThrows,
	baseAttachment,
	baseDeliveryEvent,
	baseMessage,
	baseThread,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'

const at = (time: string) => `2026-07-01T${time}.000Z`

test('Mailbox mutation RPCs: owner bind, accepted/missing/stale updates', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerA = uniqueUserId('mut-a')
	const ownerB = uniqueUserId('mut-b')
	const mailbox = rpcFor(ownerA)

	const thread = baseThread({ id: 'mut-thread' })
	const message = baseMessage(ownerA, { id: 'mut-msg', threadId: thread.id })
	await mailbox.upsertMessageGraph({
		ownerId: ownerA,
		thread,
		message,
		attachments: [baseAttachment(ownerA, message.id, { id: 'mut-att' })],
	})

	await runInDurableObject(stubFor(ownerA), async (instance: Mailbox) => {
		const ownerId = ownerB
		const deletedAt = at('13:00:00')
		const crossOwnerCalls = [
			() =>
				instance.touchThread({
					ownerId,
					threadId: thread.id,
					lastMessageAt: deletedAt,
					updatedAt: deletedAt,
				}),
			() =>
				instance.updateMessageDelivery({
					ownerId,
					messageId: message.id,
					processingStatus: 'sent',
					providerMessageId: 'prov',
					error: null,
					sentAt: deletedAt,
					updatedAt: deletedAt,
				}),
			() =>
				instance.setMessageClassification({
					ownerId,
					messageId: message.id,
					classification: 'quarantined',
					classificationReason: 'spam',
					updatedAt: deletedAt,
				}),
			() =>
				instance.deleteMessageMetadata({
					ownerId,
					messageId: message.id,
					deletedAt,
				}),
			() =>
				instance.deleteDeliveryEvent({
					ownerId,
					eventId: 'missing',
					deletedAt,
				}),
			() =>
				instance.deleteThreadIfEmpty({
					ownerId,
					threadId: thread.id,
					deletedAt,
				}),
		]
		for (const call of crossOwnerCalls) {
			await assertMailboxThrows(/ownerId mismatch/, call)
		}
	})

	// lastMessageAt only moves forward; updatedAt gates staleness.
	// [threadId, lastMessageAt, updatedAt, status, stored lastMessageAt/updatedAt]
	const touches: Array<[string, string, string, string, [string, string]?]> = [
		[
			thread.id,
			at('14:00:00'),
			at('11:00:00'),
			'stale',
			[at('12:00:00'), at('12:00:00')],
		],
		[
			thread.id,
			'2026-06-01T00:00:00.000Z',
			at('12:00:01'),
			'accepted',
			[at('12:00:00'), at('12:00:01')],
		],
		[
			thread.id,
			at('15:00:00'),
			at('12:00:02'),
			'accepted',
			[at('15:00:00'), at('12:00:02')],
		],
		['missing-thread', at('16:00:00'), at('16:00:00'), 'missing'],
	]
	for (const [threadId, lastMessageAt, updatedAt, status, stored] of touches) {
		expect(
			await mailbox.touchThread({
				ownerId: ownerA,
				threadId,
				lastMessageAt,
				updatedAt,
			}),
		).toEqual({ status })
		if (stored) {
			expect(await mailbox.getThread({ threadId })).toMatchObject({
				lastMessageAt: stored[0],
				updatedAt: stored[1],
			})
		}
	}

	const updateDelivery = (
		messageId: string,
		fields: {
			processingStatus: 'sent' | 'failed'
			providerMessageId: string | null
			error: string | null
			sentAt: string | null
			updatedAt: string
		},
	) => mailbox.updateMessageDelivery({ ownerId: ownerA, messageId, ...fields })
	expect(
		await updateDelivery(message.id, {
			processingStatus: 'failed',
			providerMessageId: 'stale-prov',
			error: 'stale',
			sentAt: null,
			updatedAt: at('11:00:00'),
		}),
	).toEqual({ status: 'stale' })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		processingStatus: 'stored',
		providerMessageId: null,
		error: null,
		updatedAt: at('12:00:00'),
	})
	expect(
		await updateDelivery('missing-msg', {
			processingStatus: 'sent',
			providerMessageId: null,
			error: null,
			sentAt: null,
			updatedAt: at('12:00:00'),
		}),
	).toEqual({ status: 'missing' })
	// Equal updatedAt is accepted.
	expect(
		await updateDelivery(message.id, {
			processingStatus: 'sent',
			providerMessageId: 'prov-1',
			error: null,
			sentAt: at('12:05:00'),
			updatedAt: at('12:00:00'),
		}),
	).toEqual({ status: 'accepted' })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		processingStatus: 'sent',
		providerMessageId: 'prov-1',
		sentAt: at('12:05:00'),
		updatedAt: at('12:00:00'),
	})

	const classify = (classificationReason: string, updatedAt: string) =>
		mailbox.setMessageClassification({
			ownerId: ownerA,
			messageId: message.id,
			classification: 'quarantined',
			classificationReason,
			updatedAt,
		})
	expect(await classify('stale', '2026-06-01T00:00:00.000Z')).toEqual({
		status: 'stale',
	})
	expect(
		await classify('Sender matched quarantine rule.', at('12:00:03')),
	).toEqual({ status: 'accepted' })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule.',
		updatedAt: at('12:00:03'),
	})
})

test('Mailbox deleteMessageMetadata and deleteThreadIfEmpty: nulls delivery message_id, no orphan/R2', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('del-msg')
	const mailbox = rpcFor(userId)
	const deleteMessage = (messageId: string, deletedAt: string) =>
		mailbox.deleteMessageMetadata({ ownerId: userId, messageId, deletedAt })
	const deleteThread = (threadId: string, deletedAt: string) =>
		mailbox.deleteThreadIfEmpty({ ownerId: userId, threadId, deletedAt })

	const thread = baseThread({ id: 'del-thread' })
	const alone = baseMessage(userId, { id: 'del-alone', threadId: thread.id })
	const attachment = baseAttachment(userId, alone.id, { id: 'del-att' })
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread,
		message: alone,
		attachments: [attachment],
	})
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'del-evt',
			messageId: alone.id,
			createdAt: at('12:00:00'),
		}),
	})

	const rawKey = emailRawMimeKey(userId, alone.id)
	const attKey = emailAttachmentBlobKey(userId, alone.id, attachment.id)
	await env.EMAIL_BLOBS.put(rawKey, 'raw-bytes')
	await env.EMAIL_BLOBS.put(attKey, 'att-bytes')

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	let blobDeleteCalls = 0
	env.EMAIL_BLOBS.delete = ((keys: string | Array<string>) => {
		blobDeleteCalls += 1
		return originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete
	using _restore = {
		[Symbol.dispose]: () => {
			env.EMAIL_BLOBS.delete = originalDelete
		},
	}

	expect(await deleteMessage(alone.id, at('11:00:00'))).toEqual({
		status: 'stale',
	})
	expect(await mailbox.getMessage({ messageId: alone.id })).not.toBeNull()
	expect(await deleteMessage(alone.id, at('12:00:00'))).toEqual({
		status: 'deleted',
	})
	expect(await mailbox.getMessage({ messageId: alone.id })).toBeNull()
	// Thread remains for deferred empty-thread cleanup.
	expect(await mailbox.getThread({ threadId: thread.id })).not.toBeNull()
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: alone.id }),
	).toHaveLength(0)
	expect(await mailbox.listDeliveryEvents({ limit: 5 })).toEqual([
		expect.objectContaining({ id: 'del-evt', messageId: null }),
	])
	expect(await env.EMAIL_BLOBS.get(rawKey)).not.toBeNull()
	expect(await env.EMAIL_BLOBS.get(attKey)).not.toBeNull()
	expect(await deleteMessage(alone.id, at('13:00:00'))).toEqual({
		status: 'missing',
	})
	expect(blobDeleteCalls).toBe(0)
	expect(
		await mailbox.upsertMessageGraph({
			ownerId: userId,
			thread,
			message: { ...alone, updatedAt: '2099-01-01T00:00:00.000Z' },
			attachments: [attachment],
		}),
	).toEqual({ ok: true, accepted: false })
	expect(await mailbox.getMessage({ messageId: alone.id })).toBeNull()

	expect(await deleteThread(thread.id, at('11:00:00'))).toEqual({
		status: 'stale',
	})
	expect(await mailbox.getThread({ threadId: thread.id })).not.toBeNull()
	expect(await deleteThread(thread.id, at('12:00:00'))).toEqual({
		status: 'deleted',
	})
	expect(await mailbox.getThread({ threadId: thread.id })).toBeNull()
	expect(await deleteThread(thread.id, at('13:00:00'))).toEqual({
		status: 'missing',
	})

	// A thread that still has a message is not deleted.
	const sharedAt = '2026-07-02T10:00:00.000Z'
	const sharedThread = baseThread({ id: 'shared-thread', updatedAt: sharedAt })
	const [keep, drop] = ['keep-msg', 'drop-msg'].map((id) =>
		baseMessage(userId, { id, threadId: sharedThread.id, updatedAt: sharedAt }),
	) as [ReturnType<typeof baseMessage>, ReturnType<typeof baseMessage>]
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread: sharedThread,
		message: keep,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message: drop })
	expect(await deleteMessage(drop.id, sharedAt)).toEqual({ status: 'deleted' })
	expect(await mailbox.getMessage({ messageId: keep.id })).not.toBeNull()
	expect(await deleteThread(sharedThread.id, sharedAt)).toEqual({
		status: 'missing',
	})
	expect(await mailbox.getThread({ threadId: sharedThread.id })).not.toBeNull()
})

test('Mailbox deleteDeliveryEvent: stale, deleted, and missing outcomes', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('del-evt')
	const mailbox = rpcFor(userId)
	const message = baseMessage(userId, {
		id: 'evt-msg',
		direction: 'outbound',
		processingStatus: 'sent',
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-del',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
		}),
	})

	// [deletedAt, status, events remaining]
	const deletes: Array<[string, string, number]> = [
		['2026-07-02T09:00:00.000Z', 'stale', 1],
		['2026-07-02T10:00:00.000Z', 'deleted', 0],
		['2026-07-02T11:00:00.000Z', 'missing', 0],
	]
	for (const [deletedAt, status, remaining] of deletes) {
		expect(
			await mailbox.deleteDeliveryEvent({
				ownerId: userId,
				eventId: 'evt-del',
				deletedAt,
			}),
		).toEqual({ status })
		expect(
			await mailbox.listDeliveryEvents({ messageId: message.id, limit: 5 }),
		).toHaveLength(remaining)
	}
})

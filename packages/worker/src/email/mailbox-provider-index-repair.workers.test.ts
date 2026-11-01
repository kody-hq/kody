import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { type Mailbox } from './mailbox-do.ts'
import {
	baseDeliveryEvent,
	baseMessage,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'
import {
	emailOutboundProviderCloudflare,
	getOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('accepted terminal persists repair, alarm repairs D1, and replay never resends', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = uniqueUserId('provider-repair')
	const messageId = 'provider-repair-message'
	const providerMessageId = 'provider-repair-id'
	// Recent so delivery-event retention (90 days) does not prune it.
	const acceptedAt = new Date(Date.now() - 60_000).toISOString()
	const mailbox = rpcFor(userId)
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: baseMessage(userId, {
			id: messageId,
			direction: 'outbound',
			processingStatus: 'stored',
			rawMimeKey: null,
			receivedAt: acceptedAt,
			createdAt: acceptedAt,
			updatedAt: acceptedAt,
		}),
	})
	const terminal = {
		ownerId: userId,
		messageId,
		processingStatus: 'sent' as const,
		providerMessageId,
		error: null,
		sentAt: acceptedAt,
		event: baseDeliveryEvent({
			id: 'provider-repair-sent-event',
			messageId,
			eventType: 'sent',
			provider: emailOutboundProviderCloudflare,
			providerMessageId,
			createdAt: acceptedAt,
			updatedAt: acceptedAt,
		}),
		providerIndexRepair: {
			provider: emailOutboundProviderCloudflare,
			providerMessageId,
			messageId,
			inboxId: null,
			createdAt: acceptedAt,
		},
	}
	await expect(mailbox.commitOutboundTerminal(terminal)).resolves.toMatchObject(
		{
			eventInserted: true,
		},
	)
	await expect(mailbox.commitOutboundTerminal(terminal)).resolves.toMatchObject(
		{
			eventInserted: false,
		},
	)
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({ ownerId: userId }),
	).resolves.toMatchObject({ pendingCount: 1 })
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toBeNull()

	await runInDurableObject(stubFor(userId), async (instance: Mailbox) => {
		await instance.alarm()
	})
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({ ownerId: userId }),
	).resolves.toMatchObject({ pendingCount: 0 })
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toMatchObject({ userId, messageId })
	expect(
		await mailbox.listDeliveryEvents({ messageId, limit: 10 }),
	).toHaveLength(1)
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'

const emailDeliveryUpdatedTopic = 'email.message.delivery.updated'
const inboundEmailReceiptTopic = 'email.message.received'
const inboundEmailQuarantinedTopic = 'email.message.quarantined'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listInternalEmailAttachmentsForMessage: vi.fn(),
	listEmailAttachmentsForMessage: vi.fn(async () => []),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('./repo.ts', () => ({
	listEmailAttachmentsForMessage: mocks.listEmailAttachmentsForMessage,
}))

vi.mock('./inbound-sender.ts', () => ({
	classifyInboundEmailSender: async () => ({ kind: 'inbox-owner' }),
	authenticatesFromAddress: () => false,
}))

vi.mock('./mailbox-internal-read.ts', () => ({
	listInternalEmailAttachmentsForMessage:
		mocks.listInternalEmailAttachmentsForMessage,
}))

const {
	dispatchEmailDeliverySubscriptionEvents,
	dispatchInboundEmailSubscriptionEvents,
} = await import('./package-subscriptions.ts')

const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: {},
	APP_BASE_URL: 'https://example.com',
} as Env

function subscribePackage(kodyId: string, topic: string) {
	const savedPackage = {
		id: `package-${kodyId}`,
		userId: ownerIdFromStored('user-1'),
		sourceId: `source-${kodyId}`,
		kodyId,
		name: `@user/${kodyId}`,
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: savedPackage.name,
			kody: {
				id: kodyId,
				description: kodyId,
				subscriptions: { [topic]: { handler: './src/handler.ts' } },
			},
		},
	})
	return savedPackage
}

test('delivery updates fan out only through the stored message owner', async () => {
	const savedPackage = subscribePackage(
		'delivery-notifier',
		emailDeliveryUpdatedTopic,
	)
	const message = {
		id: 'message-1',
		userId: ownerIdFromStored('user-1'),
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		fromAddress: 'user@inbox.example.com',
		toAddresses: ['recipient@example.net'],
		subject: 'Hello',
		processingStatus: 'sent',
		providerMessageId: 'provider-1',
		deliveryStatus: 'bounced',
		deliveryStatusAt: '2026-07-17T20:00:00.000Z',
		sentAt: '2026-07-17T19:59:00.000Z',
		createdAt: '2026-07-17T19:59:00.000Z',
	}
	const providerEvent = {
		type: 'cf.email.sending.message.bounced',
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'inbox.example.com',
		},
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			sender: 'user@inbox.example.com',
			recipient: 'recipient@example.net',
			terminal: true,
			delivery: { status: 'bounced' },
			bounce: { type: 'hard' },
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: '2026-07-17T20:00:00.000Z',
		},
	}
	const dispatch = () =>
		dispatchEmailDeliverySubscriptionEvents({
			env,
			message: message as never,
			providerEvent: providerEvent as never,
		})

	await dispatch()
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: emailDeliveryUpdatedTopic,
			idempotencyKey: `email-delivery:event-1:${savedPackage.id}`,
			source: 'email',
			params: expect.objectContaining({
				event: emailDeliveryUpdatedTopic,
				message: expect.objectContaining({
					id: 'message-1',
					delivery_status: 'bounced',
				}),
				delivery: expect.objectContaining({
					event_id: 'event-1',
					status: 'bounced',
					terminal: true,
				}),
			}),
		}),
	)

	subscribePackage('delivery-notifier', emailDeliveryUpdatedTopic)
	mocks.invokePackageSubscription.mockResolvedValueOnce({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	await expect(dispatch()).rejects.toThrow('dispatch was incomplete')
})

function inboundMessageFixture(input: {
	id: string
	classification: 'accepted' | 'quarantined'
	classificationReason: string | null
}) {
	return {
		id: input.id,
		userId: ownerIdFromStored('user-1'),
		inboxId: 'inbox-1',
		fromAddress: 'sender@example.net',
		envelopeFrom: 'sender@example.net',
		toAddresses: ['user@inbox.example.com'],
		ccAddresses: [],
		replyToAddresses: [],
		subject: 'Inbound',
		messageIdHeader: `<${input.id}@example.net>`,
		inReplyToHeader: null,
		references: [],
		processingStatus: 'stored',
		classification: input.classification,
		classificationReason: input.classificationReason,
		receivedAt: '2026-07-17T19:59:00.000Z',
		createdAt: '2026-07-17T19:59:00.000Z',
	}
}

test('accepted inbound messages dispatch email.message.received with classification fields', async () => {
	mocks.invokePackageSubscription.mockClear()
	mocks.listInternalEmailAttachmentsForMessage.mockResolvedValueOnce([
		{
			id: 'attachment-mailbox-1',
			messageId: 'accepted-1',
			filename: 'mailbox.txt',
			contentType: 'text/plain',
			contentId: null,
			disposition: 'attachment',
			size: 7,
			storageKind: 'external',
			storageKey: 'email-attachment:v1:user-1/accepted-1/attachment-mailbox-1',
			createdAt: '2026-07-17T19:59:00.000Z',
		},
	])
	const savedPackage = subscribePackage(
		'inbound-notifier',
		inboundEmailReceiptTopic,
	)
	await dispatchInboundEmailSubscriptionEvents({
		env,
		userId: ownerIdFromStored('user-1'),
		message: inboundMessageFixture({
			id: 'accepted-1',
			classification: 'accepted',
			classificationReason: null,
		}) as never,
	})

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: inboundEmailReceiptTopic,
			idempotencyKey: `email:accepted-1:${savedPackage.id}:${inboundEmailReceiptTopic}`,
			request: {
				kind: 'inbound-email',
				sourceId: 'inbox-1',
				sender: { kind: 'inbox-owner' },
			},
			inboundFromAddress: 'sender@example.net',
			inboundFromAuthenticated: false,
			params: expect.objectContaining({
				event: inboundEmailReceiptTopic,
				message: expect.objectContaining({
					id: 'accepted-1',
					classification: 'accepted',
					classification_reason: null,
				}),
				attachments: [
					expect.objectContaining({
						id: 'attachment-mailbox-1',
						filename: 'mailbox.txt',
						storage_kind: 'external',
					}),
				],
			}),
		}),
	)
	expect(mocks.listInternalEmailAttachmentsForMessage).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('user-1'),
		messageId: 'accepted-1',
	})
	expect(mocks.listEmailAttachmentsForMessage).not.toHaveBeenCalled()
})

test('quarantined inbound messages dispatch email.message.quarantined and not received', async () => {
	mocks.invokePackageSubscription.mockClear()
	mocks.listInternalEmailAttachmentsForMessage.mockResolvedValueOnce([])
	const savedPackage = subscribePackage(
		'inbound-notifier',
		inboundEmailQuarantinedTopic,
	)
	await dispatchInboundEmailSubscriptionEvents({
		env,
		userId: ownerIdFromStored('user-1'),
		message: inboundMessageFixture({
			id: 'quarantined-1',
			classification: 'quarantined',
			classificationReason: 'Sender matched quarantine rule spam.example.',
		}) as never,
	})

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: inboundEmailQuarantinedTopic,
			idempotencyKey: `email:quarantined-1:${savedPackage.id}:${inboundEmailQuarantinedTopic}`,
			params: expect.objectContaining({
				event: inboundEmailQuarantinedTopic,
				message: expect.objectContaining({
					id: 'quarantined-1',
					classification: 'quarantined',
					classification_reason: 'Sender matched quarantine rule spam.example.',
				}),
			}),
		}),
	)
})

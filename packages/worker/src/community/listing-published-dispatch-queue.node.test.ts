import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchCommunityListingPublishedSubscriptionEvent: vi.fn(),
}))

vi.mock('./listing-published-package-subscriptions.ts', () => ({
	dispatchCommunityListingPublishedSubscriptionEvent:
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
}))

const { handleCommunityListingPublishedDispatchQueue } =
	await import('./listing-published-dispatch-queue.ts')

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-07-20T01:01:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-community-listing-published-dispatch',
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('community listing published queue acks valid, invalid, and cancelled messages and retries transient failures', async () => {
	consoleError.mockImplementation(() => {})
	const valid = createQueueMessage('valid', {
		eventId: 'event-1',
		listingId: 'listing-1',
	})
	const invalidExtra = createQueueMessage('invalid-extra', {
		eventId: 'event-2',
		listingId: 'listing-2',
		extra: true,
	})
	const deleted = createQueueMessage('deleted', {
		eventId: 'event-3',
		listingId: 'listing-deleted',
	})
	const transient = createQueueMessage('transient', {
		eventId: 'event-4',
		listingId: 'listing-3',
	})
	mocks.dispatchCommunityListingPublishedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityListingPublishedDispatchCancelledError('listing-deleted'),
		)
		.mockRejectedValueOnce(new Error('D1 unavailable'))

	await handleCommunityListingPublishedDispatchQueue(
		createBatch([valid, invalidExtra, deleted, transient]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		eventId: 'event-1',
		listingId: 'listing-1',
	})
	for (const message of [valid, invalidExtra, deleted]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	expect(transient.ack).not.toHaveBeenCalled()
	expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'community-listing-published-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'transient',
			eventId: 'event-4',
			listingId: 'listing-3',
			error: expect.any(Error),
		}),
	)
})

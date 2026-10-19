import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareEmailDeliveryEvent: vi.fn(),
	applyOutboundEmailAbusePause: vi.fn(),
	applyOutboundConsecutiveFailureTracking: vi.fn(),
	dispatchEmailDeliverySubscriptionEvents: vi.fn(),
	notifyAdminsOfVerificationDeliveryFailure: vi.fn(),
}))

vi.mock('./delivery-events.ts', () => ({
	processCloudflareEmailDeliveryEvent:
		mocks.processCloudflareEmailDeliveryEvent,
}))

vi.mock('./outbound-abuse.ts', () => ({
	applyOutboundEmailAbusePause: mocks.applyOutboundEmailAbusePause,
}))

vi.mock('./outbound-consecutive-failures.ts', () => ({
	applyOutboundConsecutiveFailureTracking:
		mocks.applyOutboundConsecutiveFailureTracking,
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchEmailDeliverySubscriptionEvents:
		mocks.dispatchEmailDeliverySubscriptionEvents,
}))

vi.mock('./verification-delivery-notify.ts', () => ({
	notifyAdminsOfVerificationDeliveryFailure:
		mocks.notifyAdminsOfVerificationDeliveryFailure,
}))

const { handleEmailDeliveryQueue } = await import('./delivery-queue.ts')

test('delivery queue handles terminal outcomes without a D1-to-Mailbox graph mirror', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const providerEvent = {
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			delivery: { status: 'delivered' },
		},
		metadata: {
			eventTimestamp: '2026-07-17T20:00:00.000Z',
		},
	}
	const message = {
		id: 'message-1',
		userId: ownerIdFromStored('user-1'),
		deliveryStatusAt: '2026-07-17T20:00:00.000Z',
	}
	const transactionalEvent = {
		userId: 9,
		status: 'bounced',
		alreadyTerminal: false,
	}
	// Each queue message gets the next processor result; the third
	// subscription fan-out (dispatch-failure) throws.
	const cases = [
		['recorded', { outcome: 'recorded', providerEvent, message }, 'ack'],
		['duplicate', { outcome: 'duplicate', providerEvent, message }, 'ack'],
		[
			'invalid',
			{ outcome: 'invalid', providerEvent: null, message: null },
			'ack',
		],
		['stale', { outcome: 'stale', providerEvent, message }, 'ack'],
		[
			'unmatched',
			{ outcome: 'unmatched', providerEvent, message: null },
			'retry',
		],
		[
			'stale-transactional',
			{
				outcome: 'stale_transactional',
				providerEvent,
				message: null,
				event: null,
			},
			'ack',
		],
		[
			'transactional',
			{
				outcome: 'recorded_transactional',
				providerEvent,
				message: null,
				event: {
					...transactionalEvent,
					kind: 'email_verification',
					recipient: 'blocked@example.com',
					class: 'sender_block',
				},
			},
			'ack',
		],
		[
			'destination-transactional',
			{
				outcome: 'recorded_transactional',
				providerEvent,
				message: null,
				event: {
					...transactionalEvent,
					kind: 'email_destination_verification',
					recipient: 'pager@example.com',
					class: 'other',
				},
			},
			'ack',
		],
		[
			'dispatch-failure',
			{ outcome: 'recorded', providerEvent, message },
			'retry',
		],
	] as const
	const queueMessages = cases.map(([id, result]) => {
		mocks.processCloudflareEmailDeliveryEvent.mockResolvedValueOnce(result)
		return {
			id: `queue-${id}`,
			timestamp: new Date('2026-07-17T20:00:00.000Z'),
			body: { kind: id },
			attempts: 1,
			ack: vi.fn(),
			retry: vi.fn(),
		}
	})
	mocks.applyOutboundEmailAbusePause.mockResolvedValue(undefined)
	mocks.applyOutboundConsecutiveFailureTracking.mockResolvedValue({
		paused: false,
		consecutiveFailures: 0,
	})
	mocks.dispatchEmailDeliverySubscriptionEvents
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(new Error('transient subscription failure'))
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	const prepare = vi.fn()

	await handleEmailDeliveryQueue(
		{
			queue: 'kody-email-delivery',
			messages: queueMessages,
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<unknown>,
		{ APP_DB: { prepare } } as unknown as Env,
		ctx,
	)

	expect(
		queueMessages.map((queued) => ({
			ack: queued.ack.mock.calls,
			retry: queued.retry.mock.calls,
		})),
	).toEqual(
		cases.map(([, , settle]) =>
			settle === 'ack'
				? { ack: [[]], retry: [] }
				: { ack: [], retry: [[{ delaySeconds: 30 }]] },
		),
	)
	expect(mocks.notifyAdminsOfVerificationDeliveryFailure).toHaveBeenCalledOnce()
	expect(mocks.notifyAdminsOfVerificationDeliveryFailure).toHaveBeenCalledWith({
		env: expect.anything(),
		event: expect.objectContaining({
			status: 'bounced',
			class: 'sender_block',
			kind: 'email_verification',
		}),
		waitUntil: expect.any(Function),
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-destination-verification-delivery',
		{
			status: 'bounced',
			class: 'other',
			kind: 'email_destination_verification',
		},
	)
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledTimes(3)
	// recorded + duplicate + dispatch-failure recorded — durable pending
	// tracking must also run on duplicate so a mid-flight crash recovers.
	expect(mocks.applyOutboundConsecutiveFailureTracking).toHaveBeenCalledTimes(3)
	expect(mocks.applyOutboundConsecutiveFailureTracking).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: message.userId,
			deliveryStatus: 'delivered',
			providerEventId: 'event-1',
			eventTimestamp: '2026-07-17T20:00:00.000Z',
			messageDeliveryStatusAt: '2026-07-17T20:00:00.000Z',
		}),
	)
	expect(mocks.applyOutboundEmailAbusePause).toHaveBeenCalledTimes(4)
	expect(waitUntilPromises).toHaveLength(0)
	expect(prepare).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith('email-delivery-event-unmatched', {
		queueMessageId: 'queue-unmatched',
		providerMessageId: 'provider-1',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'email-delivery-event-processing-failed',
		expect.any(Error),
	)
})

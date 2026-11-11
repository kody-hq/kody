import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	processInboundDeliveryEffects: vi.fn(),
}))

vi.mock('./inbound-effects.ts', () => ({
	processInboundDeliveryEffects: mocks.processInboundDeliveryEffects,
}))

const {
	scheduleInboundReceivedTerminalWork,
	scheduleInboundRejectedTerminalWork,
} = await import('./inbound-mailbox.ts')

function createCapturedWaitUntilContext() {
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	return { ctx, waitUntilPromises }
}

test('received terminal work contains effect failures and rejected terminal work is already durable', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processInboundDeliveryEffects.mockRejectedValueOnce(
		new Error('effects exploded'),
	)
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
	const env = {} as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: ownerIdFromStored('user-2'),
		messageId: 'message-2',
		deliveryId: 'delivery-2',
		ctx,
		logLabel: 'Inbound email effect dispatch failed',
	})
	await scheduleInboundRejectedTerminalWork({
		env,
		userId: ownerIdFromStored('user-2'),
		deliveryId: 'delivery-3',
		ctx,
	})
	await expect(Promise.all(waitUntilPromises)).resolves.toEqual([
		undefined,
		undefined,
	])

	expect(consoleError).toHaveBeenCalledWith(
		'Inbound email effect dispatch failed',
		expect.any(Error),
	)
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledTimes(1)
})

test('received and rejected coordinators skip system:email', async () => {
	const env = {} as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']
	await scheduleInboundReceivedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		messageId: 'message-system',
		deliveryId: 'delivery-system',
		logLabel: 'System should not run',
	})
	await scheduleInboundRejectedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		deliveryId: 'delivery-system',
	})

	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()
})

test('received terminal work enqueues effects off the Email Routing invocation and falls back inline when enqueue fails', async () => {
	consoleError.mockImplementation(() => {})
	const send = vi.fn<(body: unknown) => Promise<void>>()
	const env = {
		PACKAGE_EVENTS_DISPATCH_QUEUE: { send },
	} as unknown as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: ownerIdFromStored('user-4'),
		messageId: 'message-4',
		deliveryId: 'delivery-4',
		expectedFinalizationToken: 'token-4',
		durationMs: 25,
		ctx,
		logLabel: 'Inbound email effect dispatch failed',
	})
	await Promise.all(waitUntilPromises)

	expect(send).toHaveBeenCalledWith({
		kind: 'inbound-delivery-effects',
		userId: ownerIdFromStored('user-4'),
		deliveryId: 'delivery-4',
		expectedFinalizationToken: 'token-4',
		durationMs: 25,
	})
	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()

	send.mockRejectedValueOnce(new Error('queue unavailable'))
	await scheduleInboundReceivedTerminalWork({
		env,
		userId: ownerIdFromStored('user-4'),
		messageId: 'message-5',
		deliveryId: 'delivery-5',
		logLabel: 'Inbound email effect dispatch failed',
	})

	expect(consoleError).toHaveBeenCalledWith(
		'inbound-delivery-effects-enqueue-failed',
		expect.objectContaining({ deliveryId: 'delivery-5' }),
	)
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledTimes(1)
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledWith(
		expect.objectContaining({ deliveryId: 'delivery-5' }),
	)
})

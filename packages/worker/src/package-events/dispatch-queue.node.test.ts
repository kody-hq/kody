import type * as categoryMergedDelivery from '#worker/session-analytics/category-merged-delivery.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { sessionRequestLineage } from '#worker/test-support/request-context.ts'
import { parsePackageEventsDispatchQueueMessage } from './dispatch-queue-producer.ts'

const mocks = vi.hoisted(() => ({
	deliverPackageEvent:
		vi.fn<
			(input: Record<string, unknown>) => Promise<Record<string, unknown>>
		>(),
	processInboundDeliveryEffects:
		vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
	deliverSessionCategoryMerged:
		vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
	claimPackageEventSlot: vi.fn<
		(input: { id: string }) => Promise<{ claimed: boolean; inFlight: number }>
	>(async () => ({ claimed: true, inFlight: 0 })),
	releasePackageEventSlot: vi.fn<(input: { id: string }) => Promise<void>>(
		async () => {},
	),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	claimPackageEventSlot: mocks.claimPackageEventSlot,
	releasePackageEventSlot: mocks.releasePackageEventSlot,
}))

vi.mock('#worker/email/inbound-effects.ts', () => ({
	processInboundDeliveryEffects: mocks.processInboundDeliveryEffects,
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	deliverPackageEvent: mocks.deliverPackageEvent,
}))

vi.mock(
	'#worker/session-analytics/category-merged-delivery.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof categoryMergedDelivery>()),
		deliverSessionCategoryMerged: mocks.deliverSessionCategoryMerged,
	}),
)

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => 'https://kody.dev',
}))

const { handlePackageEventsDispatchQueue } = await import('./dispatch-queue.ts')

function createMessageBody(overrides: Record<string, unknown> = {}) {
	return {
		userId: ownerIdFromStored('user-123'),
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123' },
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
		lineage: sessionRequestLineage('user-123'),
		...overrides,
	}
}

function createQueueMessage(id: string, body: unknown, attempts = 1) {
	return {
		id,
		timestamp: new Date('2026-08-04T00:01:00.000Z'),
		body,
		attempts,
		ack: vi.fn<() => void>(),
		retry: vi.fn<(options?: { delaySeconds?: number }) => void>(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-package-events-dispatch',
		messages,
		ackAll: vi.fn<() => void>(),
		retryAll: vi.fn<() => void>(),
	} as unknown as MessageBatch<unknown>
}

test('package events queue delivers valid messages and acks invalid ones', async () => {
	consoleError.mockImplementation(() => {})
	const valid = createQueueMessage('queue-valid', createMessageBody())
	const invalid = createQueueMessage('queue-invalid', { topic: '   ' })
	const handlerFailure = createQueueMessage(
		'queue-handler-failure',
		createMessageBody({ idempotencyKey: 'discord:handler-failure' }),
	)
	const infrastructureFailure = createQueueMessage(
		'queue-infra-failure',
		createMessageBody({ idempotencyKey: 'discord:infra-failure' }),
	)
	mocks.deliverPackageEvent
		.mockResolvedValueOnce({ delivered: 1, failed: 0, subscribers: [] })
		// Terminal handler failures are final (the ledger replays them on
		// retry), so the message still acks.
		.mockResolvedValueOnce({ delivered: 0, failed: 1, subscribers: [] })
		.mockRejectedValueOnce(new Error('Package event dispatch was incomplete.'))

	await handlePackageEventsDispatchQueue(
		createBatch([valid, invalid, handlerFailure, infrastructureFailure]),
		{ APP_DB: {} } as Env,
		{
			waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
		} as unknown as ExecutionContext,
	)

	expect(mocks.deliverPackageEvent).toHaveBeenCalledTimes(3)
	expect(mocks.deliverPackageEvent).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		baseUrl: 'https://kody.dev',
		message: createMessageBody(),
		waitUntil: expect.any(Function),
	})
	for (const message of [valid, invalid, handlerFailure]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	expect(infrastructureFailure.ack).not.toHaveBeenCalled()
	expect(infrastructureFailure.retry).toHaveBeenCalledWith({
		delaySeconds: 30,
	})
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-dispatch-message-invalid',
		expect.objectContaining({ queueMessageId: 'queue-invalid' }),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-dispatch-subscribers-failed',
		expect.objectContaining({
			queueMessageId: 'queue-handler-failure',
			failed: 1,
		}),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'queue-infra-failure',
			error: expect.any(Error),
		}),
	)
})

test('package events queue message parsing rejects malformed bodies', () => {
	expect(parsePackageEventsDispatchQueueMessage(createMessageBody())).toEqual(
		createMessageBody(),
	)
	expect(
		parsePackageEventsDispatchQueueMessage(
			createMessageBody({
				userId: ' user-123 ' as OwnerId,
				topic: ' topic.a ',
			}),
		),
	).toMatchObject({ userId: ownerIdFromStored('user-123'), topic: 'topic.a' })
	const malformed = [
		null,
		'nope',
		createMessageBody({ topic: ' ' }),
		// userId selects whose packages receive the event, so it enforces
		// per-user isolation across the queue boundary.
		createMessageBody({ userId: ' ' as OwnerId }),
		createMessageBody({ userId: 42 }),
		createMessageBody({ idempotencyKey: '' }),
		createMessageBody({ payload: ['nope'] }),
		createMessageBody({ source: { packageId: 'pkg-1' } }),
		createMessageBody({ invokeDepth: -1 }),
		createMessageBody({ invokeDepth: 1.5 }),
		// Subscribers inherit the emitting run, so a message must name it.
		createMessageBody({ lineage: undefined }),
		createMessageBody({ lineage: { actor: null } }),
	]
	expect(malformed.map(parsePackageEventsDispatchQueueMessage)).toEqual(
		malformed.map(() => null),
	)
})

test('package events queue message parsing keeps MCP fan-out fields only when well-formed', () => {
	const emittedAt = '2026-10-07T12:00:00.000Z'
	expect(
		parsePackageEventsDispatchQueueMessage(
			createMessageBody({ mcp: true, emittedAt }),
		),
	).toEqual({ ...createMessageBody(), mcp: true, emittedAt })
	const parsed = parsePackageEventsDispatchQueueMessage(
		createMessageBody({ mcp: 'true', emittedAt: 'yesterday' }),
	)
	expect(parsed).toEqual(createMessageBody())
})

test('inbound delivery effects run concurrently in the consumer and retry infrastructure failures', async () => {
	consoleError.mockImplementation(() => {})
	const started: Array<string> = []
	let releaseFirst: () => void = () => {}
	const firstBlocked = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})
	mocks.processInboundDeliveryEffects.mockImplementation(async (input) => {
		started.push(String(input['deliveryId']))
		if (input['deliveryId'] === 'delivery-1') await firstBlocked
		if (input['deliveryId'] === 'delivery-3') {
			throw new Error('Mailbox unavailable')
		}
		return { outcome: 'complete' }
	})
	const inbound = (deliveryId: string) =>
		createQueueMessage(`queue-${deliveryId}`, {
			kind: 'inbound-delivery-effects',
			userId: ownerIdFromStored('user-123'),
			deliveryId,
			expectedFinalizationToken: `token-${deliveryId}`,
			durationMs: 12,
		})
	const first = inbound('delivery-1')
	const second = inbound('delivery-2')
	const third = inbound('delivery-3')
	const invalid = createQueueMessage('queue-inbound-invalid', {
		kind: 'inbound-delivery-effects',
		userId: 'user-123',
	})

	const handled = handlePackageEventsDispatchQueue(
		createBatch([first, second, third, invalid]),
		{ APP_DB: {} } as Env,
		{
			waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
		} as unknown as ExecutionContext,
	)
	// A slow first delivery must not hold back the independent ones.
	await vi.waitFor(() => {
		expect(second.ack).toHaveBeenCalledTimes(1)
		expect(third.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	})
	expect(first.ack).not.toHaveBeenCalled()
	releaseFirst()
	await handled

	expect(started).toEqual(['delivery-1', 'delivery-2', 'delivery-3'])
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('user-123'),
		deliveryId: 'delivery-1',
		expectedFinalizationToken: 'token-delivery-1',
		durationMs: 12,
		waitUntil: expect.any(Function),
	})
	expect(first.ack).toHaveBeenCalledTimes(1)
	expect(third.ack).not.toHaveBeenCalled()
	expect(invalid.ack).toHaveBeenCalledTimes(1)
	expect(mocks.deliverPackageEvent).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'inbound-delivery-effects-message-invalid',
		expect.objectContaining({ queueMessageId: 'queue-inbound-invalid' }),
	)
})

test('an event whose owner is at the cap is put back with a delay instead of delivered or retried', async () => {
	mocks.deliverPackageEvent.mockClear()
	mocks.releasePackageEventSlot.mockClear()
	mocks.deliverPackageEvent.mockResolvedValue({
		delivered: 1,
		failed: 0,
		subscribers: [],
	})
	mocks.claimPackageEventSlot
		.mockResolvedValueOnce({ claimed: false, inFlight: 4 })
		.mockResolvedValueOnce({ claimed: true, inFlight: 0 })
	const send =
		vi.fn<(body: unknown, options?: { delaySeconds?: number }) => void>()
	const capped = createQueueMessage(
		'queue-capped',
		createMessageBody({ deferrals: 2 }),
	)
	const other = createQueueMessage(
		'queue-other-owner',
		createMessageBody({ userId: ownerIdFromStored('user-456') }),
	)

	await handlePackageEventsDispatchQueue(
		createBatch([capped, other]),
		{ APP_DB: {}, PACKAGE_EVENTS_DISPATCH_QUEUE: { send } } as unknown as Env,
		{
			waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
		} as unknown as ExecutionContext,
	)

	expect(send).toHaveBeenCalledTimes(1)
	expect(send.mock.calls[0]?.[0]).toEqual(createMessageBody({ deferrals: 3 }))
	const delaySeconds = send.mock.calls[0]?.[1]?.delaySeconds ?? 0
	expect(delaySeconds).toBeGreaterThanOrEqual(10)
	expect(delaySeconds).toBeLessThanOrEqual(20)
	expect(capped.ack).toHaveBeenCalledTimes(1)
	expect(capped.retry).not.toHaveBeenCalled()
	expect(mocks.deliverPackageEvent).toHaveBeenCalledTimes(1)
	expect(mocks.releasePackageEventSlot).toHaveBeenCalledTimes(1)
	expect(mocks.releasePackageEventSlot).toHaveBeenCalledWith(
		expect.objectContaining({ id: 'queue-other-owner' }),
	)
	expect(other.ack).toHaveBeenCalledTimes(1)
})

test('a capped event that already failed keeps its failure count when it is put back, and dead-letters once that count is spent', async () => {
	mocks.deliverPackageEvent.mockClear()
	mocks.claimPackageEventSlot.mockClear()
	mocks.claimPackageEventSlot.mockResolvedValueOnce({
		claimed: false,
		inFlight: 4,
	})
	const send =
		vi.fn<(body: unknown, options?: { delaySeconds?: number }) => void>()
	// Two failures before an earlier put-back, one more since.
	const failedBefore = createQueueMessage(
		'queue-failed-before',
		createMessageBody({ deferrals: 1, priorAttempts: 2 }),
		2,
	)
	// Four failures in total: one more than the consumer's three retries.
	const spent = createQueueMessage(
		'queue-spent',
		createMessageBody({ deferrals: 1, priorAttempts: 3 }),
		2,
	)

	await handlePackageEventsDispatchQueue(
		createBatch([failedBefore, spent]),
		{ APP_DB: {}, PACKAGE_EVENTS_DISPATCH_QUEUE: { send } } as unknown as Env,
		{
			waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
		} as unknown as ExecutionContext,
	)

	expect(send).toHaveBeenCalledTimes(1)
	expect(send.mock.calls[0]?.[0]).toEqual(
		createMessageBody({ deferrals: 2, priorAttempts: 3 }),
	)
	expect(failedBefore.ack).toHaveBeenCalledTimes(1)
	expect(failedBefore.retry).not.toHaveBeenCalled()
	expect(spent.retry).toHaveBeenCalledWith()
	expect(spent.ack).not.toHaveBeenCalled()
	expect(mocks.claimPackageEventSlot).toHaveBeenCalledTimes(1)
	expect(mocks.deliverPackageEvent).not.toHaveBeenCalled()
})

test('a failed session.category.merged delivery is retried after 30 seconds and a delivered one is acked', async () => {
	consoleError.mockImplementation(() => {})
	const event = {
		event: 'session.category.merged',
		from: { id: 'cat-2', name: 'managing file' },
		into: { id: 'cat-1', name: 'manage files' },
		observed_at: '2026-11-30T00:00:00.000Z',
	}
	const body = { kind: 'session-category-merged', event }
	const delivered = createQueueMessage('merge-delivered', body)
	const failed = createQueueMessage('merge-failed', body, 2)
	const invalid = createQueueMessage('merge-invalid', {
		kind: 'session-category-merged',
	})
	mocks.deliverSessionCategoryMerged
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new Error('Admin package subscription discovery failed.'),
		)

	await handlePackageEventsDispatchQueue(
		createBatch([delivered, failed, invalid]),
		{ APP_DB: {} } as Env,
		{
			waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
		} as unknown as ExecutionContext,
	)

	expect(mocks.deliverSessionCategoryMerged).toHaveBeenCalledTimes(2)
	expect(mocks.deliverSessionCategoryMerged).toHaveBeenCalledWith(
		expect.objectContaining({ event }),
	)
	expect(delivered.ack).toHaveBeenCalledTimes(1)
	expect(invalid.ack).toHaveBeenCalledTimes(1)
	expect(failed.ack).not.toHaveBeenCalled()
	expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
})

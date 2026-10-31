import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { parsePackageEventsDispatchQueueMessage } from './dispatch-queue-producer.ts'

const mocks = vi.hoisted(() => ({
	deliverPackageEvent:
		vi.fn<
			(input: Record<string, unknown>) => Promise<Record<string, unknown>>
		>(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	deliverPackageEvent: mocks.deliverPackageEvent,
}))

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
		...overrides,
	}
}

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-08-04T00:01:00.000Z'),
		body,
		attempts: 1,
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

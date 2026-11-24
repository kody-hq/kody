import { Data, Effect } from 'effect'
import { expect, test, vi } from 'vitest'
import { runEdge } from './edge.ts'
import { type QueueDisposition, settleQueueBatch } from './queue.ts'

class TestFailure extends Data.TaggedError('TestFailure')<{
	readonly message: string
}> {}

function queueMessage(id: string) {
	const calls: Array<string> = []
	return {
		id,
		calls,
		ack: () => calls.push('ack'),
		retry: (options?: { delaySeconds?: number }) =>
			calls.push(`retry:${options?.delaySeconds}`),
	}
}

test('every message in a partially failing batch is settled exactly once', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const messages = ['ok', 'throws', 'retry', 'fallback-throws'].map(
		queueMessage,
	)
	await runEdge(
		settleQueueBatch({
			consumer: 'test',
			messages,
			failureRetryDelaySeconds: 9,
			decide: (message): Effect.Effect<QueueDisposition, TestFailure> => {
				if (message.id === 'ok') return Effect.succeed({ kind: 'ack' })
				if (message.id === 'retry') {
					return Effect.succeed({ kind: 'retry', delaySeconds: 3 })
				}
				return Effect.fail(new TestFailure({ message: message.id }))
			},
			onDecideFailure: (message) =>
				message.id === 'fallback-throws'
					? Effect.die(new TestFailure({ message: 'fallback' }))
					: Effect.succeed({ kind: 'retry', delaySeconds: 5 }),
		}),
	)
	expect(messages.map((message) => message.calls)).toEqual([
		['ack'],
		['retry:5'],
		['retry:3'],
		['retry:9'],
	])
	expect(consoleError).toHaveBeenCalledWith(
		'test-failure-handling-failed',
		expect.objectContaining({ queueMessageId: 'fallback-throws' }),
	)
	consoleError.mockRestore()
})

test('afterAck runs only after the ack and its failure is reported, not thrown', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const message = queueMessage('m')
	await runEdge(
		settleQueueBatch({
			consumer: 'test',
			messages: [message],
			failureRetryDelaySeconds: 9,
			decide: () =>
				Effect.succeed({
					kind: 'ack',
					afterAck: Effect.sync(() => message.calls.push('cleanup')).pipe(
						Effect.andThen(
							Effect.fail(new TestFailure({ message: 'cleanup failed' })),
						),
					),
				}),
			onDecideFailure: () => Effect.succeed({ kind: 'retry', delaySeconds: 1 }),
		}),
	)
	expect(message.calls).toEqual(['ack', 'cleanup'])
	expect(consoleError).toHaveBeenCalledWith(
		'test-after-ack-failed',
		expect.objectContaining({ queueMessageId: 'm' }),
	)
	consoleError.mockRestore()
})

test('concurrency caps in-flight decisions and defaults to one at a time', async () => {
	for (const [concurrency, expected] of [
		[undefined, 1],
		[2, 2],
	] as const) {
		let inFlight = 0
		let peak = 0
		await runEdge(
			settleQueueBatch({
				consumer: 'test',
				messages: ['a', 'b', 'c', 'd', 'e'].map(queueMessage),
				failureRetryDelaySeconds: 1,
				concurrency,
				decide: () =>
					Effect.sync(() => {
						inFlight += 1
						peak = Math.max(peak, inFlight)
					}).pipe(
						Effect.andThen(Effect.yieldNow),
						Effect.andThen(
							Effect.sync(() => {
								inFlight -= 1
								return { kind: 'ack' } as const
							}),
						),
					),
				onDecideFailure: () =>
					Effect.succeed({ kind: 'retry', delaySeconds: 1 }),
			}),
		)
		expect(peak).toBe(expected)
	}
})

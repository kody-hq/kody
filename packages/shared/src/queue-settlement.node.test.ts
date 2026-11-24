import { expect, test, vi } from 'vitest'
import { type QueueDisposition, settleQueueBatch } from './queue-settlement.ts'

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
	await settleQueueBatch({
		consumer: 'test',
		messages,
		failureRetryDelaySeconds: 9,
		decide: async (message): Promise<QueueDisposition> => {
			if (message.id === 'ok') return { kind: 'ack' }
			if (message.id === 'retry') return { kind: 'retry', delaySeconds: 3 }
			throw new Error(message.id)
		},
		onDecideFailure: async (message) => {
			if (message.id === 'fallback-throws') throw new Error('fallback')
			return { kind: 'retry', delaySeconds: 5 }
		},
	})
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
	await settleQueueBatch({
		consumer: 'test',
		messages: [message],
		failureRetryDelaySeconds: 9,
		decide: async () => ({
			kind: 'ack',
			afterAck: async () => {
				message.calls.push('cleanup')
				throw new Error('cleanup failed')
			},
		}),
		onDecideFailure: async () => ({ kind: 'retry', delaySeconds: 1 }),
	})
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
		await settleQueueBatch({
			consumer: 'test',
			messages: ['a', 'b', 'c', 'd', 'e'].map(queueMessage),
			failureRetryDelaySeconds: 1,
			concurrency,
			decide: async () => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await new Promise((resolve) => setImmediate(resolve))
				inFlight -= 1
				return { kind: 'ack' }
			},
			onDecideFailure: async () => ({ kind: 'retry', delaySeconds: 1 }),
		})
		expect(peak).toBe(expected)
	}
})

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
		[2.9, 2],
		[0, 1],
		[Number.NaN, 1],
		[Number.POSITIVE_INFINITY, 1],
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

test('a throwing ack or retry is reported and the rest of the batch still settles', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const broken = {
		id: 'broken',
		ack: () => {
			throw new Error('already settled')
		},
		retry: () => {},
	}
	const after = queueMessage('after')
	await settleQueueBatch({
		consumer: 'test',
		messages: [broken, after],
		failureRetryDelaySeconds: 1,
		decide: async () => ({ kind: 'ack' }),
		onDecideFailure: async () => ({ kind: 'retry', delaySeconds: 1 }),
	})
	expect(after.calls).toEqual(['ack'])
	expect(consoleError).toHaveBeenCalledWith(
		'test-settle-failed',
		expect.objectContaining({ queueMessageId: 'broken', disposition: 'ack' }),
	)
	consoleError.mockRestore()
})

test('retry delays are clamped to what Cloudflare Queues accepts', async () => {
	const messages = ['nan', 'negative', 'fraction', 'huge'].map(queueMessage)
	const delays: Record<string, number> = {
		nan: Number.NaN,
		negative: -5,
		fraction: 1.2,
		huge: 10 ** 9,
	}
	await settleQueueBatch({
		consumer: 'test',
		messages,
		failureRetryDelaySeconds: 1,
		decide: async (message) => ({
			kind: 'retry',
			delaySeconds: delays[message.id]!,
		}),
		onDecideFailure: async () => ({ kind: 'retry', delaySeconds: 1 }),
	})
	expect(messages.map((message) => message.calls)).toEqual([
		['retry:0'],
		['retry:0'],
		['retry:2'],
		[`retry:${12 * 60 * 60}`],
	])
})

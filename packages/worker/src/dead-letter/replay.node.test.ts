import { expect, test, vi } from 'vitest'
import { packageEventsDispatchDeadLetterQueueName } from '#worker/package-events/dispatch-queue-names.ts'
import { deadLetterQueues } from './queues.ts'
import {
	type DeadLetterReplayEnv,
	sendDeadLetterBodyToSourceQueue,
} from './replay.ts'

test('a replayed message leaves behind the attempt counts from before it was dead-lettered', async () => {
	const send = vi.fn<(body: unknown, options?: unknown) => Promise<void>>()
	const queue = deadLetterQueues.find(
		(entry) => entry.name === packageEventsDispatchDeadLetterQueueName,
	)!

	await sendDeadLetterBodyToSourceQueue({
		env: {
			PACKAGE_EVENTS_DISPATCH_QUEUE: { send },
		} as unknown as DeadLetterReplayEnv,
		queue,
		body: { topic: 'demo.changed', deferrals: 6, priorAttempts: 4 },
	})

	expect(send).toHaveBeenCalledWith(
		{ topic: 'demo.changed' },
		{ contentType: 'json' },
	)
})

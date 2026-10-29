import { expect, test, vi } from 'vitest'
import { packageEventsDispatchQueueName } from '#worker/package-events/dispatch-queue-names.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { webhookDispatchQueueName } from '#worker/webhooks/dispatch-queue-names.ts'

const mocks = vi.hoisted(() => ({
	handleCommunityActivityDispatchQueue: vi.fn(),
	handleCommunityListingPublishedDispatchQueue: vi.fn(),
	handleEmailDeliveryQueue: vi.fn(),
	handleArtifactsRepoEventsQueue: vi.fn(),
	handlePackageEventsDispatchQueue: vi.fn(),
	handlePlatformFeedbackDispatchQueue: vi.fn(),
	handleWebhookDispatchQueue: vi.fn(),
	handleDeadLetterQueueBatch: vi.fn(),
}))

vi.mock('#worker/community/activity-dispatch-queue.ts', () => ({
	handleCommunityActivityDispatchQueue:
		mocks.handleCommunityActivityDispatchQueue,
}))

vi.mock(
	import('#worker/community/activity-dispatch-queue-names.ts'),
	async (importOriginal) => ({
		...(await importOriginal()),
		communityActivityDispatchQueueName:
			'kody-community-activity-dispatch' as const,
	}),
)

vi.mock('#worker/community/listing-published-dispatch-queue.ts', () => ({
	handleCommunityListingPublishedDispatchQueue:
		mocks.handleCommunityListingPublishedDispatchQueue,
}))

vi.mock(
	import('#worker/community/listing-published-dispatch-queue-names.ts'),
	async (importOriginal) => ({
		...(await importOriginal()),
		communityListingPublishedDispatchQueueName:
			'kody-community-listing-published-dispatch' as const,
	}),
)

vi.mock('#worker/dead-letter/consumer.ts', () => ({
	handleDeadLetterQueueBatch: mocks.handleDeadLetterQueueBatch,
}))

vi.mock('#worker/email/delivery-queue.ts', () => ({
	emailDeliveryQueueName: 'kody-email-delivery',
	handleEmailDeliveryQueue: mocks.handleEmailDeliveryQueue,
}))

vi.mock('#worker/repo/artifacts-event-queue.ts', () => ({
	artifactsRepoEventsQueueName: 'kody-artifacts-repo-events',
	handleArtifactsRepoEventsQueue: mocks.handleArtifactsRepoEventsQueue,
}))

vi.mock('#worker/package-events/dispatch-queue.ts', () => ({
	handlePackageEventsDispatchQueue: mocks.handlePackageEventsDispatchQueue,
}))

vi.mock('#worker/platform-feedback/dispatch-queue.ts', () => ({
	handlePlatformFeedbackDispatchQueue:
		mocks.handlePlatformFeedbackDispatchQueue,
}))

vi.mock('#worker/webhooks/dispatch-queue.ts', () => ({
	handleWebhookDispatchQueue: mocks.handleWebhookDispatchQueue,
	webhookDispatchQueueName: 'kody-webhook-dispatch',
}))

const { handleQueueBatch } = await import('./queue-handler.ts')

function createBatch(queue: string) {
	return {
		queue,
		messages: [],
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('worker queue routing isolates known queues and retries unknown queues', async () => {
	consoleError.mockImplementation(() => {})
	const env = {} as Env
	const ctx = {} as ExecutionContext
	const routes: Array<[string, ReturnType<typeof vi.fn>, boolean]> = [
		['kody-email-delivery', mocks.handleEmailDeliveryQueue, true],
		['kody-artifacts-repo-events', mocks.handleArtifactsRepoEventsQueue, true],
		[
			'kody-platform-feedback-dispatch',
			mocks.handlePlatformFeedbackDispatchQueue,
			true,
		],
		[
			'kody-community-activity-dispatch',
			mocks.handleCommunityActivityDispatchQueue,
			true,
		],
		[
			'kody-community-listing-published-dispatch',
			mocks.handleCommunityListingPublishedDispatchQueue,
			true,
		],
		[
			packageEventsDispatchQueueName,
			mocks.handlePackageEventsDispatchQueue,
			true,
		],
		// Webhook dispatch does not take the execution context.
		[webhookDispatchQueueName, mocks.handleWebhookDispatchQueue, false],
	]
	const batches = routes.map(([queue]) => createBatch(queue))
	const unknownBatch = createBatch('unexpected-queue')
	for (const batch of [...batches, unknownBatch]) {
		await handleQueueBatch(batch, env, ctx)
	}

	expect(routes.map(([, handler]) => handler.mock.calls)).toEqual(
		routes.map(([, , takesCtx], index) => [
			takesCtx ? [batches[index], env, ctx] : [batches[index], env],
		]),
	)
	expect(unknownBatch.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith('unknown-worker-queue', {
		queue: 'unexpected-queue',
	})

	const previewBatch = createBatch('kody-pr-3155-platform-feedback-dispatch')
	await handleQueueBatch(previewBatch, env, ctx)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledTimes(2)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenLastCalledWith(
		previewBatch,
		env,
		ctx,
	)

	const deadLetterBatch = createBatch(
		'kody-pr-3155-platform-feedback-dispatch-dlq',
	)
	await handleQueueBatch(deadLetterBatch, env, ctx)
	expect(deadLetterBatch.retryAll).not.toHaveBeenCalled()
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledTimes(2)
	expect(mocks.handleDeadLetterQueueBatch).toHaveBeenCalledWith(
		deadLetterBatch,
		env,
		expect.objectContaining({
			name: 'kody-platform-feedback-dispatch-dlq',
			sourceQueue: 'kody-platform-feedback-dispatch',
		}),
	)
})

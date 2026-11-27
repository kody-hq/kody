import { beforeEach, expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))
vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const {
	deliverSessionCategoryMerged,
	enqueueSessionCategoryMerged,
	parseSessionCategoryMergedQueueMessage,
} = await import('./category-merged-delivery.ts')

const event = {
	event: 'session.category.merged' as const,
	from: { id: 'cat-2', name: 'managing file' },
	into: { id: 'cat-1', name: 'manage files' },
	observed_at: '2026-11-30T00:00:00.000Z',
}

function createEnv(queue?: { send: (body: unknown) => Promise<void> }) {
	return {
		APP_DB: {},
		APP_BASE_URL: 'https://kody.example.com',
		PACKAGE_EVENTS_DISPATCH_QUEUE: queue,
	} as unknown as Env
}

beforeEach(() => {
	mocks.dispatchAdminPackageSubscriptionEvent.mockReset()
})

test('a merge is handed to the queue as a message the consumer can parse', async () => {
	const sent: Array<unknown> = []
	await enqueueSessionCategoryMerged({
		env: createEnv({ send: async (body) => void sent.push(body) }),
		event,
	})
	expect(mocks.dispatchAdminPackageSubscriptionEvent).not.toHaveBeenCalled()
	expect(sent).toHaveLength(1)
	expect(parseSessionCategoryMergedQueueMessage(sent[0])?.event).toEqual(event)
	expect(
		parseSessionCategoryMergedQueueMessage({
			kind: 'session-category-merged',
			event: { ...event, from: { id: 'cat-2' } },
		}),
	).toBeNull()
})

test('delivery asks for retries and keeps one idempotency key per merge and package', async () => {
	mocks.dispatchAdminPackageSubscriptionEvent.mockResolvedValue([])
	await deliverSessionCategoryMerged({ env: createEnv(), event })
	await deliverSessionCategoryMerged({ env: createEnv(), event })
	const calls = mocks.dispatchAdminPackageSubscriptionEvent.mock.calls.map(
		([input]) => input,
	)
	expect(calls).toHaveLength(2)
	for (const call of calls) {
		expect(call).toMatchObject({
			topic: 'session.category.merged',
			retryDiscoveryFailures: true,
			retryInvocationInfrastructureFailures: true,
		})
		expect(call.getParams()).toEqual(event)
		expect(call.buildIdempotencyKey({ id: 'pkg-1' })).toBe(
			'session.category.merged:cat-2:pkg-1',
		)
	}
})

test('a merge is delivered inline when there is no queue or the send fails, and never throws', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.dispatchAdminPackageSubscriptionEvent.mockResolvedValueOnce([])
	await enqueueSessionCategoryMerged({ env: createEnv(), event })
	expect(mocks.dispatchAdminPackageSubscriptionEvent).toHaveBeenCalledTimes(1)

	mocks.dispatchAdminPackageSubscriptionEvent.mockRejectedValueOnce(
		new Error('discovery failed'),
	)
	await enqueueSessionCategoryMerged({
		env: createEnv({
			send: async () => {
				throw new Error('queue down')
			},
		}),
		event,
	})
	expect(mocks.dispatchAdminPackageSubscriptionEvent).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'session-category-merged-enqueue-failed',
		expect.objectContaining({ categoryId: 'cat-2' }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'session-analytics-event-dispatch-failed',
		expect.objectContaining({ topic: 'session.category.merged' }),
	)
})

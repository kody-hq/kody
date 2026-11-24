import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { reportConsumerError } from './consumer-errors.ts'

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	setTag: vi.fn(),
	setContext: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	withScope: (callback: (scope: unknown) => void) =>
		callback({ setTag: sentry.setTag, setContext: sentry.setContext }),
	captureException: sentry.captureException,
	captureMessage: sentry.captureMessage,
}))

test('a consumer error is logged and sent to Sentry with its event and context', () => {
	consoleError.mockImplementation(() => {})
	const error = new Error('run log down')

	reportConsumerError('webhook-dispatch-decide-failed', {
		queueMessageId: 'm-1',
		error,
	})
	reportConsumerError('webhook-dispatch-message-invalid', {
		queueMessageId: 'm-2',
	})

	expect(consoleError).toHaveBeenCalledWith('webhook-dispatch-decide-failed', {
		queueMessageId: 'm-1',
		error,
	})
	expect(sentry.captureException).toHaveBeenCalledWith(error)
	expect(sentry.captureMessage).toHaveBeenCalledWith(
		'webhook-dispatch-message-invalid',
		'error',
	)
	expect(sentry.setTag).toHaveBeenCalledWith(
		'queue_consumer.event',
		'webhook-dispatch-decide-failed',
	)
	expect(sentry.setContext).toHaveBeenCalledWith('queue_consumer', {
		queueMessageId: 'm-1',
	})
})

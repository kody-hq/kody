import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))
vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { handleConsentOutboxMessages } = await import('./edges.ts')

function queueMessage(body: unknown) {
	return {
		id: crypto.randomUUID(),
		body,
		timestamp: new Date(),
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	} as unknown as Message<unknown> & {
		ack: ReturnType<typeof vi.fn>
		retry: ReturnType<typeof vi.fn>
	}
}

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'https://kody.example.com',
		PACKAGE_EVENTS_DISPATCH_QUEUE: { send: vi.fn(async () => {}) },
	} as unknown as Env
	return { sqlite, env }
}

test('the queue edge acks malformed bodies and retries failed deliveries, in order', async () => {
	const { sqlite, env } = setup()
	consoleError.mockImplementation(() => {})
	sqlite
		.prepare(
			`INSERT INTO newsletter_signups (stable_id, email, status, requested_at, confirmed_at, updated_at) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'guest@example.com', 'confirmed', '2026-11-15', '2026-11-15', '2026-11-15')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO whats_new_consent_outbox (id, recipient_id, opted_in, source, occurred_at, created_at) VALUES ('row-1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 'newsletter_page', '2026-11-15', '2026-11-15')`,
		)
		.run()
	mocks.dispatchAdminPackageSubscriptionEvent.mockRejectedValueOnce(
		new Error('discovery failed'),
	)
	const malformed = queueMessage({
		kind: 'whats-new-consent-outbox',
		outboxId: ' ',
	})
	const missing = queueMessage({
		kind: 'whats-new-consent-outbox',
		outboxId: 'gone',
	})
	const failing = queueMessage({
		kind: 'whats-new-consent-outbox',
		outboxId: 'row-1',
	})
	const background: Array<Promise<unknown>> = []

	await handleConsentOutboxMessages({
		env,
		messages: [malformed, missing, failing],
		waitUntil: (promise) => void background.push(promise),
		retryDelaySeconds: 30,
	})

	expect(malformed.ack).toHaveBeenCalledTimes(1)
	expect(missing.ack).toHaveBeenCalledTimes(1)
	expect(failing.ack).not.toHaveBeenCalled()
	expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('whats-new-consent-outbox-message-invalid'),
	)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('whats-new-consent-outbox-queue-processing-failed'),
	)
})

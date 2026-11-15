import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
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

const {
	deliverWhatsNewConsentOutboxRow,
	parseWhatsNewConsentOutboxQueueMessage,
	recordWhatsNewConsentChange,
	recordWhatsNewVerifiedAccount,
	whatsNewConsentChangedTopic,
} = await import('./consent-outbox.ts')

const now = new Date('2026-11-15T12:00:00.000Z')
const accountId = 'a'.repeat(64)
const signupId = 'b'.repeat(64)

type Dispatch = {
	getParams: () => Record<string, unknown>
	buildIdempotencyKey: (savedPackage: { id: string }) => string
	topic: string
}

function setup(input: { failSend?: boolean } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const sent: Array<unknown> = []
	const queue = {
		send: vi.fn(async (body: unknown) => {
			if (input.failSend) throw new Error('queue down')
			sent.push(body)
		}),
	}
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.example.com',
		PACKAGE_EVENTS_DISPATCH_QUEUE: queue,
	} as unknown as Env
	sqlite
		.prepare(
			`INSERT INTO users (stable_user_id, personal_org_id, username, email, password_hash, email_verified_at, whats_new_email_opt_in, whats_new_email_opt_in_updated_at, whats_new_email_opt_in_source) VALUES (?, 'org-1', 'reader', 'reader@example.com', 'hash', '2026-11-14T00:00:00.000Z', 1, '2026-11-13T00:00:00.000Z', 'signup')`,
		)
		.run(accountId)
	sqlite
		.prepare(
			`INSERT INTO newsletter_signups (stable_id, email, status, requested_at, confirmed_at, updated_at) VALUES (?, 'guest@example.com', 'confirmed', ?, ?, ?)`,
		)
		.run(signupId, now.toISOString(), now.toISOString(), now.toISOString())
	const outbox = () =>
		sqlite
			.prepare(
				`SELECT id, recipient_id AS stable_user_id, opted_in, source, attempts FROM whats_new_consent_outbox ORDER BY created_at, id`,
			)
			.all() as Array<{
			id: string
			stable_user_id: string
			opted_in: number | null
			source: string | null
			attempts: number
		}>
	return { env, sqlite, sent, queue, outbox }
}

beforeEach(() => {
	mocks.dispatchAdminPackageSubscriptionEvent.mockReset()
})

test('a consent change is stored and enqueued, then delivered to admin subscribers and cleared', async () => {
	const { env, sent, outbox } = setup()
	await recordWhatsNewConsentChange({
		env,
		stableUserId: signupId,
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: now.toISOString(),
		now,
	})
	const [row] = outbox()
	expect(row).toMatchObject({
		stable_user_id: signupId,
		opted_in: 1,
		source: 'newsletter_page',
		attempts: 0,
	})
	expect(sent).toEqual([
		{ kind: 'whats-new-consent-outbox', outboxId: row!.id },
	])
	expect(parseWhatsNewConsentOutboxQueueMessage(sent[0])).toEqual(sent[0])

	let dispatched: Dispatch | undefined
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: Dispatch) => {
			dispatched = input
			return [{ status: 200, body: {} }]
		},
	)
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id }),
	).resolves.toEqual({ delivered: 1 })
	expect(dispatched!.topic).toBe(whatsNewConsentChangedTopic)
	expect(dispatched!.getParams()).toEqual({
		event: 'whats_new.consent.changed',
		event_id: row!.id,
		subscriber: {
			stable_user_id: signupId,
			email: 'guest@example.com',
			username: '',
		},
		consent: {
			opted_in: true,
			source: 'newsletter_page',
			occurred_at: now.toISOString(),
		},
	})
	expect(dispatched!.buildIdempotencyKey({ id: 'pkg-1' })).toBe(
		`whats-new-consent:${row!.id}:1:pkg-1`,
	)
	expect(outbox()).toEqual([])
	// A redelivered queue message finds nothing left to send.
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id }),
	).resolves.toEqual({ delivered: 0 })
	expect(mocks.dispatchAdminPackageSubscriptionEvent).toHaveBeenCalledTimes(1)
})

test('a failed queue send never throws and the next change enqueues the stranded row', async () => {
	const failing = setup({ failSend: true })
	consoleError.mockImplementation(() => {})
	await expect(
		recordWhatsNewConsentChange({
			env: failing.env,
			stableUserId: signupId,
			optedIn: true,
			source: 'newsletter_page',
			occurredAt: now.toISOString(),
			now,
		}),
	).resolves.toBeUndefined()
	expect(consoleError).toHaveBeenCalledTimes(1)
	const [stranded] = failing.outbox()
	expect(stranded).toBeDefined()

	const sent: Array<unknown> = []
	failing.queue.send.mockImplementation(async (body: unknown) => {
		sent.push(body)
	})
	await recordWhatsNewConsentChange({
		env: failing.env,
		stableUserId: accountId,
		optedIn: false,
		source: 'admin',
		occurredAt: now.toISOString(),
		now: new Date(now.getTime() + 5 * 60 * 1000),
	})
	const rows = failing.outbox()
	expect(rows).toHaveLength(2)
	expect(sent).toEqual([
		{ kind: 'whats-new-consent-outbox', outboxId: rows[1]!.id },
		{ kind: 'whats-new-consent-outbox', outboxId: stranded!.id },
	])
})

test('a failed delivery keeps the row and throws so the queue retries with a fresh key', async () => {
	const { env, outbox } = setup()
	await recordWhatsNewConsentChange({
		env,
		stableUserId: accountId,
		optedIn: false,
		source: 'admin',
		occurredAt: now.toISOString(),
		now,
	})
	const [row] = outbox()
	const keys: Array<string> = []
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: Dispatch) => {
			keys.push(input.buildIdempotencyKey({ id: 'pkg-1' }))
			return [{ status: 500, body: {} }]
		},
	)
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id }),
	).rejects.toThrow('was not handled by 1 of 1 subscribers')
	mocks.dispatchAdminPackageSubscriptionEvent.mockRejectedValueOnce(
		new Error('discovery failed'),
	)
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id }),
	).rejects.toThrow('discovery failed')
	expect(outbox()).toMatchObject([{ id: row!.id, attempts: 2 }])
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: Dispatch) => {
			keys.push(input.buildIdempotencyKey({ id: 'pkg-1' }))
			return [{ status: 200, body: {} }]
		},
	)
	await deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id })
	expect(keys).toEqual([
		`whats-new-consent:${row!.id}:1:pkg-1`,
		`whats-new-consent:${row!.id}:3:pkg-1`,
	])
	expect(outbox()).toEqual([])
})

test('a verified account is announced with its sign-up choice, or with none', async () => {
	const { env, sqlite, outbox } = setup()
	await recordWhatsNewVerifiedAccount({ env, stableUserId: accountId, now })
	expect(outbox()).toMatchObject([
		{ stable_user_id: accountId, opted_in: 1, source: 'signup' },
	])
	sqlite.prepare(`DELETE FROM whats_new_consent_outbox`).run()
	sqlite
		.prepare(
			`UPDATE users SET whats_new_email_opt_in = 0, whats_new_email_opt_in_updated_at = NULL, whats_new_email_opt_in_source = NULL`,
		)
		.run()
	await recordWhatsNewVerifiedAccount({ env, stableUserId: accountId, now })
	expect(outbox()).toMatchObject([
		{ stable_user_id: accountId, opted_in: null, source: null },
	])
	// An unverified account is not a recipient yet.
	sqlite.prepare(`DELETE FROM whats_new_consent_outbox`).run()
	sqlite.prepare(`UPDATE users SET email_verified_at = NULL`).run()
	await recordWhatsNewVerifiedAccount({ env, stableUserId: accountId, now })
	expect(outbox()).toEqual([])
})

test('a row whose recipient is gone is dropped without dispatching', async () => {
	const { env, sqlite, outbox } = setup()
	await recordWhatsNewConsentChange({
		env,
		stableUserId: signupId,
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: now.toISOString(),
		now,
	})
	sqlite.prepare(`DELETE FROM newsletter_signups`).run()
	await deliverWhatsNewConsentOutboxRow({ env, outboxId: outbox()[0]!.id })
	expect(mocks.dispatchAdminPackageSubscriptionEvent).not.toHaveBeenCalled()
	expect(outbox()).toEqual([])
})

test('a change is kept, uncounted, while no admin package subscribes', async () => {
	const { env, outbox } = setup()
	await recordWhatsNewConsentChange({
		env,
		stableUserId: signupId,
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: now.toISOString(),
		now,
	})
	const [row] = outbox()
	mocks.dispatchAdminPackageSubscriptionEvent.mockResolvedValue([])
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId: row!.id }),
	).resolves.toEqual({ delivered: 0 })
	expect(outbox()).toMatchObject([{ id: row!.id, attempts: 0 }])
})

test('without a queue binding a change is delivered inline', async () => {
	const { env, outbox } = setup()
	delete (env as Partial<Env>).PACKAGE_EVENTS_DISPATCH_QUEUE
	mocks.dispatchAdminPackageSubscriptionEvent.mockResolvedValue([
		{ status: 200, body: {} },
	])
	await recordWhatsNewConsentChange({
		env,
		stableUserId: signupId,
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: now.toISOString(),
		now,
	})
	expect(mocks.dispatchAdminPackageSubscriptionEvent).toHaveBeenCalledTimes(1)
	expect(outbox()).toEqual([])
})

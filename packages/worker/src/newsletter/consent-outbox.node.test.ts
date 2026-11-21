import { DatabaseSync } from 'node:sqlite'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, expect, vi } from 'vitest'
import { Background } from '#worker/effect/background.ts'
import { D1 } from '#worker/effect/d1.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { captureLogs } from '#worker/test-support/effect-test-logger.ts'
import {
	ConsentDispatch,
	ConsentOutboxQueue,
	decodeWhatsNewConsentOutboxMessage,
	deliverWhatsNewConsentOutboxRow,
	recordWhatsNewConsentChange,
	recordWhatsNewVerifiedAccount,
	whatsNewConsentChangedTopic,
} from './consent-outbox.ts'
import { isWhatsNewConsentOutboxQueueBody } from './consent-outbox-edge.ts'
import * as entrypoints from './entrypoints.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))
vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const startedAt = Date.parse('2026-11-15T12:00:00.000Z')
const startedAtIso = new Date(startedAt).toISOString()
const atStart = TestClock.setTime(startedAt)
const accountId = 'a'.repeat(64)
const signupId = 'b'.repeat(64)

type Dispatch = {
	getParams: () => Record<string, unknown>
	buildIdempotencyKey: (savedPackage: { id: string }) => string
	topic: string
}

function setup(input: { queue?: 'bound' | 'inline' } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const sent: Array<unknown> = []
	const queue = {
		send: vi.fn(async (body: unknown) => {
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
		.run(signupId, startedAtIso, startedAtIso, startedAtIso)
	const { logs, layer: logLayer } = captureLogs()
	const d1 = D1.layer(db)
	const dispatch = ConsentDispatch.layer(env)
	const producer =
		input.queue === 'inline'
			? ConsentOutboxQueue.inlineLayer.pipe(Layer.provide(dispatch))
			: ConsentOutboxQueue.queueLayer(queue as unknown as Queue)
	const layer = Layer.mergeAll(producer, dispatch).pipe(
		Layer.provideMerge(d1),
		Layer.provide(Background.inline),
		Layer.provideMerge(logLayer),
	)
	const outbox = () =>
		sqlite
			.prepare(
				`SELECT id, recipient_id AS stable_user_id, opted_in, source, occurred_at, attempts FROM whats_new_consent_outbox ORDER BY created_at, id`,
			)
			.all() as Array<{
			id: string
			stable_user_id: string
			opted_in: number | null
			source: string | null
			occurred_at: string
			attempts: number
		}>
	const record = (
		change: Partial<Parameters<typeof recordWhatsNewConsentChange>[0]> = {},
	) =>
		recordWhatsNewConsentChange({
			stableUserId: signupId,
			optedIn: true,
			source: 'newsletter_page',
			occurredAt: startedAtIso,
			...change,
		}).pipe(Effect.provide(layer))
	const deliver = (outboxId: string) =>
		deliverWhatsNewConsentOutboxRow(outboxId).pipe(Effect.provide(layer))
	const announce = (stableUserId: string) =>
		recordWhatsNewVerifiedAccount(stableUserId).pipe(Effect.provide(layer))
	return { env, sqlite, sent, queue, logs, outbox, record, deliver, announce }
}

const dispatchesWith = (
	...responses: Array<{ status: number; body: unknown }>
) => mocks.dispatchAdminPackageSubscriptionEvent.mockResolvedValue(responses)

beforeEach(() => {
	mocks.dispatchAdminPackageSubscriptionEvent.mockReset()
})

describe('the queue message schema', () => {
	it('routes on kind and decodes only well-formed messages', () => {
		const message = { kind: 'whats-new-consent-outbox', outboxId: ' id-1 ' }
		expect(isWhatsNewConsentOutboxQueueBody(message)).toBe(true)
		expect(isWhatsNewConsentOutboxQueueBody({ kind: 'package-event' })).toBe(
			false,
		)
		expect(isWhatsNewConsentOutboxQueueBody(null)).toBe(false)
		expect(decodeWhatsNewConsentOutboxMessage(message)).toEqual(
			Option.some({ kind: 'whats-new-consent-outbox', outboxId: 'id-1' }),
		)
		for (const outboxId of [undefined, '', '  ', 42])
			expect(
				decodeWhatsNewConsentOutboxMessage({
					kind: 'whats-new-consent-outbox',
					outboxId,
				}),
			).toEqual(Option.none())
	})
})

describe('the What’s New consent outbox', () => {
	it.effect(
		'a consent change is stored and enqueued, then delivered to admin subscribers and cleared',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.record()
				const [row] = t.outbox()
				expect(row).toMatchObject({
					stable_user_id: signupId,
					opted_in: 1,
					source: 'newsletter_page',
					attempts: 0,
				})
				expect(t.sent).toEqual([
					{ kind: 'whats-new-consent-outbox', outboxId: row!.id },
				])
				expect(decodeWhatsNewConsentOutboxMessage(t.sent[0])).toEqual(
					Option.some(t.sent[0]),
				)

				dispatchesWith({ status: 200, body: {} })
				assert.deepStrictEqual(yield* t.deliver(row!.id), { delivered: 1 })
				const dispatched = mocks.dispatchAdminPackageSubscriptionEvent.mock
					.calls[0]![0] as Dispatch
				expect(dispatched.topic).toBe(whatsNewConsentChangedTopic)
				expect(dispatched.getParams()).toEqual({
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
						occurred_at: startedAtIso,
					},
				})
				expect(dispatched.buildIdempotencyKey({ id: 'pkg-1' })).toBe(
					`whats-new-consent:${row!.id}:1:pkg-1`,
				)
				expect(t.outbox()).toEqual([])
				// A redelivered queue message finds nothing left to send.
				assert.deepStrictEqual(yield* t.deliver(row!.id), { delivered: 0 })
				expect(
					mocks.dispatchAdminPackageSubscriptionEvent,
				).toHaveBeenCalledTimes(1)
			}),
	)

	it.effect(
		'a failing queue send is retried with backoff, then surfaces as OutboxEnqueueError; the next change sweeps the stranded row',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				t.queue.send.mockRejectedValue(new Error('queue down'))
				const fiber = yield* Effect.forkChild(Effect.flip(t.record()))
				yield* TestClock.adjust('99 millis')
				expect(t.queue.send).toHaveBeenCalledTimes(1)
				yield* TestClock.adjust('1 millis')
				expect(t.queue.send).toHaveBeenCalledTimes(2)
				yield* TestClock.adjust('200 millis')
				const error = yield* Fiber.join(fiber)
				assert.strictEqual(error._tag, 'OutboxEnqueueError')
				expect(t.queue.send).toHaveBeenCalledTimes(3)
				const [stranded] = t.outbox()

				t.queue.send.mockImplementation(async (body: unknown) => {
					t.sent.push(body)
				})
				// Younger than two minutes: not swept yet.
				yield* t.record({
					stableUserId: accountId,
					optedIn: false,
					source: 'admin',
				})
				expect(t.sent).toHaveLength(1)
				yield* TestClock.adjust('5 minutes')
				yield* t.record({
					stableUserId: accountId,
					optedIn: false,
					source: 'admin',
				})
				const rows = t.outbox()
				expect(rows).toHaveLength(3)
				expect(t.sent.slice(1)).toEqual([
					{ kind: 'whats-new-consent-outbox', outboxId: rows[2]!.id },
					{ kind: 'whats-new-consent-outbox', outboxId: stranded!.id },
					{ kind: 'whats-new-consent-outbox', outboxId: rows[1]!.id },
				])
			}),
	)

	it('the Promise edge for account flows never rejects when the queue is down', async () => {
		const t = setup()
		t.queue.send.mockRejectedValue(new Error('queue down'))
		consoleError.mockImplementation(() => {})
		await expect(
			entrypoints.recordWhatsNewConsentChange({
				env: t.env,
				stableUserId: signupId,
				optedIn: true,
				source: 'newsletter_page',
				occurredAt: startedAtIso,
			}),
		).resolves.toBeUndefined()
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('whats-new-consent-outbox-record-failed'),
		)
		expect(t.outbox()).toHaveLength(1)
	})

	it.effect(
		'a failed delivery keeps the row and fails so the queue retries with a fresh key',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.record({
					stableUserId: accountId,
					optedIn: false,
					source: 'admin',
				})
				const [row] = t.outbox()
				const keys: Array<string> = []
				mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
					async (input: Dispatch) => {
						keys.push(input.buildIdempotencyKey({ id: 'pkg-1' }))
						return [{ status: 500, body: {} }]
					},
				)
				const handlersFailed = yield* Effect.flip(t.deliver(row!.id))
				expect(handlersFailed).toMatchObject({
					_tag: 'ConsentDispatchError',
					reason: 'handlers_failed',
					failed: 1,
					total: 1,
				})
				mocks.dispatchAdminPackageSubscriptionEvent.mockRejectedValueOnce(
					new Error('discovery failed'),
				)
				const dispatchFailed = yield* Effect.flip(t.deliver(row!.id))
				expect(dispatchFailed).toMatchObject({
					_tag: 'ConsentDispatchError',
					reason: 'dispatch_failed',
				})
				expect(t.outbox()).toMatchObject([{ id: row!.id, attempts: 2 }])
				mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
					async (input: Dispatch) => {
						keys.push(input.buildIdempotencyKey({ id: 'pkg-1' }))
						return [{ status: 200, body: {} }]
					},
				)
				yield* t.deliver(row!.id)
				expect(keys).toEqual([
					`whats-new-consent:${row!.id}:1:pkg-1`,
					`whats-new-consent:${row!.id}:3:pkg-1`,
				])
				expect(t.outbox()).toEqual([])
			}),
	)

	it.effect('a drifted row shape fails loudly as a DatabaseError', () =>
		Effect.gen(function* () {
			const t = setup()
			const error = yield* D1.use((d1) =>
				d1.first({
					name: 'drift.probe',
					sql: `SELECT recipient_id, attempts AS opted_in FROM whats_new_consent_outbox UNION ALL SELECT 'x', 'yes'`,
					row: Schema.Struct({
						recipient_id: Schema.String,
						opted_in: Schema.NullOr(Schema.Literals([0, 1])),
					}),
				}),
			).pipe(Effect.flip, Effect.provide(D1.layer(t.env.APP_DB)))
			expect(error).toMatchObject({
				_tag: 'DatabaseError',
				query: 'drift.probe',
				reason: 'row_shape',
			})
		}),
	)

	it.effect(
		'a verified account is announced with its sign-up choice, or with none',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.announce(accountId)
				expect(t.outbox()).toMatchObject([
					{ stable_user_id: accountId, opted_in: 1, source: 'signup' },
				])
				t.sqlite.prepare(`DELETE FROM whats_new_consent_outbox`).run()
				t.sqlite
					.prepare(
						`UPDATE users SET whats_new_email_opt_in = 0, whats_new_email_opt_in_updated_at = NULL, whats_new_email_opt_in_source = NULL`,
					)
					.run()
				yield* t.announce(accountId)
				expect(t.outbox()).toMatchObject([
					{ stable_user_id: accountId, opted_in: null, source: null },
				])
				// An unverified account is not a recipient yet.
				t.sqlite.prepare(`DELETE FROM whats_new_consent_outbox`).run()
				t.sqlite.prepare(`UPDATE users SET email_verified_at = NULL`).run()
				yield* t.announce(accountId)
				expect(t.outbox()).toEqual([])
			}),
	)

	it.effect(
		'a row whose recipient is gone is dropped without dispatching',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.record()
				t.sqlite.prepare(`DELETE FROM newsletter_signups`).run()
				assert.deepStrictEqual(yield* t.deliver(t.outbox()[0]!.id), {
					delivered: 0,
				})
				expect(
					mocks.dispatchAdminPackageSubscriptionEvent,
				).not.toHaveBeenCalled()
				expect(t.outbox()).toEqual([])
			}),
	)

	it.effect(
		'a change is kept, uncounted, while no admin package subscribes',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.record()
				const [row] = t.outbox()
				dispatchesWith()
				assert.deepStrictEqual(yield* t.deliver(row!.id), { delivered: 0 })
				expect(t.outbox()).toMatchObject([{ id: row!.id, attempts: 0 }])
			}),
	)

	it.effect(
		'an account with no choice of its own is announced with the public sign-up its address confirmed',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				t.sqlite
					.prepare(
						`UPDATE users SET email = 'guest@example.com', whats_new_email_opt_in = 0, whats_new_email_opt_in_updated_at = NULL, whats_new_email_opt_in_source = NULL`,
					)
					.run()
				// The account's own no-choice event is newer than the sign-up it carries.
				yield* t.record({
					stableUserId: accountId,
					optedIn: null,
					source: null,
					occurredAt: '2026-11-16T09:00:00.000Z',
				})
				yield* t.announce(accountId)
				const carried = t.outbox().find((row) => row.opted_in === 1)
				expect(carried).toMatchObject({
					stable_user_id: accountId,
					source: 'newsletter_page',
					occurred_at: startedAtIso,
				})
				// The newer no-choice row carries no consent, so the opt-in is still sent.
				dispatchesWith({ status: 200, body: {} })
				assert.deepStrictEqual(yield* t.deliver(carried!.id), { delivered: 1 })
			}),
	)

	it.effect('without a queue binding a change is delivered inline', () =>
		Effect.gen(function* () {
			yield* atStart
			const t = setup({ queue: 'inline' })
			dispatchesWith({ status: 200, body: {} })
			yield* t.record()
			expect(mocks.dispatchAdminPackageSubscriptionEvent).toHaveBeenCalledTimes(
				1,
			)
			expect(t.sent).toEqual([])
			expect(t.outbox()).toEqual([])
		}),
	)

	it.effect(
		'an older change that arrives late is dropped while a newer one for the same recipient waits',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				dispatchesWith({ status: 200, body: {} })
				yield* t.record({ occurredAt: '2026-11-15T12:00:00.000Z' })
				yield* t.record({
					optedIn: false,
					source: 'admin',
					occurredAt: '2026-11-15T12:05:00.000Z',
				})
				const optIn = t.outbox().find((row) => row.opted_in === 1)
				const optOut = t.outbox().find((row) => row.opted_in === 0)
				// The opt-in's retry lands first: it is superseded, so nothing is sent.
				assert.deepStrictEqual(yield* t.deliver(optIn!.id), { delivered: 0 })
				expect(
					mocks.dispatchAdminPackageSubscriptionEvent,
				).not.toHaveBeenCalled()
				expect(t.outbox().map((row) => row.id)).toEqual([optOut!.id])
				assert.deepStrictEqual(yield* t.deliver(optOut!.id), { delivered: 1 })
				const dispatch = mocks.dispatchAdminPackageSubscriptionEvent.mock
					.calls[0]![0] as Dispatch
				expect(dispatch.getParams()).toMatchObject({
					consent: { opted_in: false, occurred_at: '2026-11-15T12:05:00.000Z' },
				})
				expect(t.outbox()).toEqual([])
			}),
	)
})

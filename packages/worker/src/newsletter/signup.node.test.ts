import { DatabaseSync } from 'node:sqlite'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, vi } from 'vitest'
import {
	honeypotFieldName,
	turnstileResponseFieldName,
} from '#universal/public-form-protection.ts'
import {
	listWhatsNewRecipients,
	setWhatsNewOptIn,
} from '#worker/admin/whats-new.ts'
import { Background } from '#worker/effect/background.ts'
import { D1 } from '#worker/effect/d1.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { captureLogs } from '#worker/test-support/effect-test-logger.ts'
import { NewsletterAudit } from './audit.ts'
import { ConsentOutboxQueue } from './consent-outbox.ts'
import { HumanVerification } from './human-verification.ts'
import { NewsletterMailer } from './mailer.ts'
import { RateLimiter } from './rate-limiter.ts'
import {
	buildNewsletterConfirmEmail,
	confirmNewsletterSignup,
	newsletterSignupEmailRateLimit,
	newsletterSignupIpRateLimit,
	requestNewsletterSignup,
} from './signup.ts'

const mocks = vi.hoisted(() => ({ sendNewsletterConfirmationEmail: vi.fn() }))
vi.mock('#worker/email/system-outbound.ts', () => ({
	sendNewsletterConfirmationEmail: mocks.sendNewsletterConfirmationEmail,
}))

const startedAt = Date.parse('2026-11-15T12:00:00.000Z')
const startedAtIso = new Date(startedAt).toISOString()
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

/** Every test starts at the same instant on the TestClock. */
const atStart = TestClock.setTime(startedAt)

/** Lets retries and timeouts run by moving the TestClock forward. */
const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect)
		for (let step = 0; step < 40; step++) yield* TestClock.adjust('500 millis')
		return yield* Fiber.join(fiber)
	})

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.example.com',
		SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
		TURNSTILE_SITE_KEY: 'site-key',
		TURNSTILE_SECRET_KEY: 'secret-key',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	const siteverify = vi.fn(
		async (_url: unknown, _init?: RequestInit): Promise<Response> =>
			Response.json({ success: true, hostname: 'kody.example.com' }),
	)
	vi.stubGlobal('fetch', siteverify)
	const enqueued: Array<unknown> = []
	const { logs, layer: logLayer } = captureLogs()
	const layer = Layer.mergeAll(
		RateLimiter.layer,
		HumanVerification.layer(env),
		NewsletterMailer.layer(env),
		NewsletterAudit.layer(env),
		ConsentOutboxQueue.queueLayer({
			send: async (body: unknown) => void enqueued.push(body),
		} as unknown as Queue),
	).pipe(
		Layer.provideMerge(D1.layer(db)),
		Layer.provide(Background.inline),
		Layer.provideMerge(logLayer),
	)
	/** `ok`, or the tag of the typed failure the route maps to a page error. */
	const outcome = <E extends { readonly _tag: string }>(
		effect: Effect.Effect<void, E, Layer.Success<typeof layer>>,
	) =>
		effect.pipe(
			Effect.as('ok'),
			Effect.catch((error) => Effect.succeed(error._tag)),
			Effect.provide(layer),
		)
	let ipCounter = 0
	const request = (ip = `203.0.113.${++ipCounter}`) =>
		new Request('https://kody.example.com/newsletter', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': ip },
		})
	const signup = (
		email: string | undefined,
		extra: Record<string, string> = {},
		ip?: string,
	) =>
		outcome(
			requestNewsletterSignup(request(ip), {
				...(email === undefined ? {} : { email }),
				[turnstileResponseFieldName]: 'turnstile-token',
				...extra,
			}),
		)
	const confirm = (token: string | undefined) =>
		outcome(confirmNewsletterSignup(request(), token))
	const sentToken = (call = -1) => {
		const input = mocks.sendNewsletterConfirmationEmail.mock.calls.at(call)![0]
		return /\/newsletter\/confirm\?token=([a-f0-9]{64})/.exec(input.text)![1]!
	}
	const user = (email: string, optIn = 0, updatedAt: string | null = null) => {
		const id = 'a'.repeat(64)
		sqlite
			.prepare(
				`INSERT INTO users (stable_user_id, personal_org_id, username, email, password_hash, email_verified_at, whats_new_email_opt_in, whats_new_email_opt_in_updated_at) VALUES (?, 'org-1', 'reader', ?, 'hash', '2026-11-14', ?, ?)`,
			)
			.run(id, email, optIn, updatedAt)
		return id
	}
	const recipients = (audience: 'opted-in' | 'all-users' = 'opted-in') =>
		Effect.promise(() => listWhatsNewRecipients({ db, audience, limit: 100 }))
	const optIn = (input: Parameters<typeof setWhatsNewOptIn>[0]) =>
		Effect.promise(() => setWhatsNewOptIn(input))
	const rows = () =>
		sqlite.prepare('SELECT * FROM newsletter_signups').all() as Array<
			Record<string, unknown>
		>
	const outbox = () =>
		sqlite
			.prepare(
				`SELECT recipient_id AS stable_user_id, opted_in, source, occurred_at FROM whats_new_consent_outbox ORDER BY created_at, rowid`,
			)
			.all()
	return {
		db,
		sqlite,
		signup,
		confirm,
		sentToken,
		user,
		recipients,
		optIn,
		rows,
		outbox,
		enqueued,
		logs,
		siteverify,
	}
}

describe('newsletter sign-up', () => {
	it.effect(
		'a sign-up only emails a confirmation link; the address joins the list when the link is confirmed, once',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				assert.strictEqual(yield* t.signup('  New.Reader@Example.com '), 'ok')
				expect(mocks.sendNewsletterConfirmationEmail).toHaveBeenCalledTimes(1)
				expect(
					mocks.sendNewsletterConfirmationEmail.mock.calls[0]![0],
				).toMatchObject({
					to: 'new.reader@example.com',
					subject: "Confirm your What's New in Kody subscription",
					now: new Date(startedAt),
				})
				const token = t.sentToken()
				// Only a hash of the token is stored, and nobody is a recipient yet.
				expect(t.rows()).toEqual([
					expect.objectContaining({
						email: 'new.reader@example.com',
						status: 'pending',
						confirmed_at: null,
						token_expires_at: startedAt + sevenDaysMs,
					}),
				])
				expect(JSON.stringify(t.rows())).not.toContain(token)
				expect((yield* t.recipients('all-users')).users).toEqual([])

				assert.strictEqual(yield* t.confirm(token), 'ok')
				const stableId = t.rows()[0]!.stable_id as string
				expect(stableId).toMatch(/^[a-f0-9]{64}$/)
				expect((yield* t.recipients()).users).toEqual([
					{
						stable_user_id: stableId,
						email: 'new.reader@example.com',
						username: '',
						opted_in: true,
						opt_in_updated_at: startedAtIso,
						opt_in_source: 'newsletter_page',
						unsubscribed: false,
					},
				])
				// The link is single use.
				assert.strictEqual(yield* t.confirm(token), 'InvalidConfirmLink')

				yield* t.optIn({
					db: t.db,
					stable_user_id: stableId,
					opted_in: false,
					source: 'email_link',
				})
				expect((yield* t.recipients()).users).toEqual([])
				// Signing up again needs a fresh confirmation and keeps the same id.
				yield* t.signup('new.reader@example.com')
				expect((yield* t.recipients()).users).toEqual([])
				assert.strictEqual(yield* t.confirm(t.sentToken()), 'ok')
				expect((yield* t.recipients()).users[0]).toMatchObject({
					stable_user_id: stableId,
					opt_in_source: 'newsletter_page',
				})
				expect(logAuditEventSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						action: 'newsletter_signup_confirm',
						result: 'success',
					}),
				)
			}),
	)

	it.effect('a pending sign-up cannot be switched on without its link', () =>
		Effect.gen(function* () {
			yield* atStart
			const t = setup()
			yield* t.signup('pending@example.com')
			const error = yield* Effect.flip(
				Effect.tryPromise(() =>
					setWhatsNewOptIn({
						db: t.db,
						stable_user_id: t.rows()[0]!.stable_id as string,
						opted_in: true,
						source: 'admin',
					}),
				),
			)
			expect(String(error.cause)).toContain('User not found.')
			expect((yield* t.recipients('all-users')).users).toEqual([])
		}),
	)

	it.effect(
		'malformed and missing tokens confirm nothing; a link expires after 7 days on the clock',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.signup('late@example.com')
				const first = t.sentToken()
				for (const token of [
					undefined,
					'',
					'nope',
					'A'.repeat(64),
					'b'.repeat(64),
				])
					assert.strictEqual(yield* t.confirm(token), 'InvalidConfirmLink')
				// A newer link replaces the older one.
				yield* t.signup('late@example.com')
				const second = t.sentToken()
				assert.notStrictEqual(second, first)
				assert.strictEqual(yield* t.confirm(first), 'InvalidConfirmLink')

				yield* TestClock.adjust('7 days')
				assert.strictEqual(yield* t.confirm(second), 'InvalidConfirmLink')
				expect((yield* t.recipients('all-users')).users).toEqual([])
			}),
	)

	it.effect('a link still confirms just before it expires', () =>
		Effect.gen(function* () {
			yield* atStart
			const t = setup()
			yield* t.signup('prompt@example.com')
			yield* TestClock.adjust(sevenDaysMs - 1)
			assert.strictEqual(yield* t.confirm(t.sentToken()), 'ok')
		}),
	)

	it.effect('invalid addresses are rejected without an email', () =>
		Effect.gen(function* () {
			yield* atStart
			const t = setup()
			for (const email of [
				undefined,
				'',
				'nope',
				'a@b',
				'two@@example.com',
				'a b@example.com',
				"o'connor@example.com",
				`${'x'.repeat(250)}@example.com`,
			])
				assert.strictEqual(yield* t.signup(email), 'InvalidEmail')
			expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()
			expect(t.rows()).toEqual([])
		}),
	)

	it.effect(
		'a filled honeypot gets the normal success result and no email or row',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				assert.strictEqual(
					yield* t.signup('bot@example.com', {
						[honeypotFieldName]: 'https://spam',
					}),
					'ok',
				)
				expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()
				expect(t.siteverify).not.toHaveBeenCalled()
				expect(t.rows()).toEqual([])
			}),
	)

	it.effect(
		'rate limits: per IP is reported, per address is silent, and both windows slide on the clock',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				const ip = '198.51.100.7'
				for (let i = 0; i < newsletterSignupIpRateLimit.maxRequests; i++)
					assert.strictEqual(
						yield* t.signup(`ip${i}@example.com`, {}, ip),
						'ok',
					)
				assert.strictEqual(
					yield* t.signup('ip-over@example.com', {}, ip),
					'SignupRateLimited',
				)
				yield* TestClock.adjust(
					`${newsletterSignupIpRateLimit.windowSeconds + 1} seconds`,
				)
				assert.strictEqual(
					yield* t.signup('ip-later@example.com', {}, ip),
					'ok',
				)

				mocks.sendNewsletterConfirmationEmail.mockClear()
				for (let i = 0; i < newsletterSignupEmailRateLimit.maxRequests + 2; i++)
					assert.strictEqual(yield* t.signup('flood@example.com'), 'ok')
				expect(mocks.sendNewsletterConfirmationEmail).toHaveBeenCalledTimes(
					newsletterSignupEmailRateLimit.maxRequests,
				)
			}),
	)

	it.effect(
		'already subscribed addresses and failed sends look like any other sign-up',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.signup('again@example.com')
				yield* t.confirm(t.sentToken())
				t.user('member@example.com', 1, '2026-11-14')
				mocks.sendNewsletterConfirmationEmail.mockClear()
				assert.strictEqual(yield* t.signup('again@example.com'), 'ok')
				assert.strictEqual(yield* t.signup('member@example.com'), 'ok')
				expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()

				mocks.sendNewsletterConfirmationEmail.mockRejectedValueOnce(
					new Error('rejected fail@example.com'),
				)
				assert.strictEqual(yield* t.signup('fail@example.com'), 'ok')
				expect(t.logs).toContainEqual({
					level: 'Warn',
					message: [
						'newsletter-signup-confirm-email-failed',
						'rejected [email]',
					],
				})
				expect(logAuditEventSpy).toHaveBeenCalledWith(
					expect.objectContaining({ reason: 'send_failed' }),
				)
			}),
	)

	it.effect(
		'confirming an address with a verified account sets consent on the account and lists it once',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				const id = t.user('member@example.com', 0, '2026-11-01')
				yield* t.signup('member@example.com')
				expect((yield* t.recipients()).users).toEqual([])
				yield* t.confirm(t.sentToken())
				expect((yield* t.recipients('all-users')).users).toEqual([
					{
						stable_user_id: id,
						email: 'member@example.com',
						username: 'reader',
						opted_in: true,
						opt_in_updated_at: startedAtIso,
						opt_in_source: 'newsletter_page',
						unsubscribed: false,
					},
				])
			}),
	)

	it.effect(
		'a sign-up confirmed before the account existed carries over while the account has made no choice',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.signup('early@example.com')
				yield* t.confirm(t.sentToken())
				const id = t.user('early@example.com')
				expect((yield* t.recipients()).users).toEqual([
					expect.objectContaining({
						stable_user_id: id,
						opted_in: true,
						opt_in_source: 'newsletter_page',
						opt_in_updated_at: startedAtIso,
					}),
				])
			}),
	)

	it.effect(
		'confirming records the consent change in the outbox and enqueues it, under the account id when there is one',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				yield* t.signup('guest@example.com')
				// A bad link records nothing.
				yield* t.confirm('0'.repeat(64))
				expect(t.outbox()).toEqual([])
				yield* t.confirm(t.sentToken())
				expect(t.outbox()).toEqual([
					{
						stable_user_id: t.rows()[0]!['stable_id'],
						opted_in: 1,
						source: 'newsletter_page',
						occurred_at: startedAtIso,
					},
				])
				expect(t.enqueued).toEqual([
					{ kind: 'whats-new-consent-outbox', outboxId: expect.any(String) },
				])
				const accountId = t.user('member@example.com')
				yield* t.signup('member@example.com')
				yield* t.confirm(t.sentToken())
				expect(t.outbox().at(-1)).toMatchObject({ stable_user_id: accountId })
			}),
	)

	it('the confirmation email states the double opt-in terms and has no em dashes', () => {
		const message = buildNewsletterConfirmEmail({
			appBaseUrl: 'https://kody.example.com',
			confirmUrl: 'https://kody.example.com/newsletter/confirm?token=abc',
		})
		expect(message.text).toContain('You are not subscribed until you do.')
		expect(message.text).toContain('expires in 7 days')
		expect(message.html).toContain(
			'https://kody.example.com/newsletter/confirm?token=abc',
		)
		expect(`${message.subject}${message.text}`).not.toContain('\u2014')
	})

	it('the sign-up lifecycle only joins the list through a confirmed link and never returns to pending', async () => {
		const { canHandle } = await import('@kody-internal/shared/state-machine.ts')
		const { newsletterSignupState: machine } = await import('./signup-state.ts')
		expect(canHandle(machine, 'pending', 'CONFIRM')).toBe(true)
		expect(canHandle(machine, 'pending', 'RESUBSCRIBE')).toBe(false)
		expect(canHandle(machine, 'pending', 'UNSUBSCRIBE')).toBe(false)
		expect(canHandle(machine, 'confirmed', 'UNSUBSCRIBE')).toBe(true)
		expect(canHandle(machine, 'confirmed', 'CONFIRM')).toBe(false)
		expect(canHandle(machine, 'unsubscribed', 'RESUBSCRIBE')).toBe(true)
		expect(canHandle(machine, 'unsubscribed', 'CONFIRM')).toBe(true)
	})
})

describe('Turnstile human verification', () => {
	it.effect(
		'a sign-up verifies its token with siteverify before any email',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				assert.strictEqual(yield* t.signup('reader@example.com'), 'ok')
				expect(t.siteverify).toHaveBeenCalledTimes(1)
				const [url, init] = t.siteverify.mock.calls[0]!
				expect(url).toBe(
					'https://challenges.cloudflare.com/turnstile/v0/siteverify',
				)
				const body = init!.body as URLSearchParams
				expect(body.get('secret')).toBe('secret-key')
				expect(body.get('response')).toBe('turnstile-token')
				expect(body.get('remoteip')).toMatch(/^203\.0\.113\./)
				expect(init!.signal).toBeInstanceOf(AbortSignal)
				expect(t.rows()).toHaveLength(1)
			}),
	)

	it.effect(
		'a rejected, foreign, malformed, or missing token creates no sign-up and sends no email',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				t.siteverify.mockResolvedValueOnce(
					Response.json({ success: false, 'error-codes': ['invalid-input'] }),
				)
				assert.strictEqual(
					yield* t.signup('reader@example.com'),
					'VerificationFailed',
				)
				// A token minted for another hostname is refused too.
				t.siteverify.mockResolvedValueOnce(
					Response.json({ success: true, hostname: 'elsewhere.example.com' }),
				)
				assert.strictEqual(
					yield* t.signup('reader@example.com'),
					'VerificationFailed',
				)
				expect(t.logs).toContainEqual(
					expect.objectContaining({
						level: 'Warn',
						message: [
							'turnstile-hostname-mismatch',
							{
								expected: 'kody.example.com',
								received: 'elsewhere.example.com',
							},
						],
					}),
				)
				// A 200 whose body is not the siteverify shape fails closed.
				t.siteverify.mockResolvedValueOnce(Response.json({ success: 'yes' }))
				assert.strictEqual(
					yield* t.signup('reader@example.com'),
					'VerificationFailed',
				)
				t.siteverify.mockResolvedValueOnce(new Response('<html>'))
				assert.strictEqual(
					yield* t.signup('reader@example.com'),
					'VerificationFailed',
				)
				t.siteverify.mockClear()
				assert.strictEqual(
					yield* t.signup('reader@example.com', {
						[turnstileResponseFieldName]: '',
					}),
					'VerificationFailed',
				)
				expect(t.siteverify).not.toHaveBeenCalled()
				expect(t.rows()).toEqual([])
				expect(mocks.sendNewsletterConfirmationEmail).not.toHaveBeenCalled()
			}),
	)

	it.effect('an outage is retried with backoff, then fails closed', () =>
		Effect.gen(function* () {
			yield* atStart
			const t = setup()
			t.siteverify.mockRejectedValueOnce(new Error('siteverify is down'))
			t.siteverify.mockResolvedValueOnce(new Response(null, { status: 503 }))
			assert.strictEqual(yield* settle(t.signup('retry@example.com')), 'ok')
			expect(t.siteverify).toHaveBeenCalledTimes(3)

			t.siteverify.mockClear()
			t.siteverify.mockRejectedValue(new Error('siteverify is down'))
			assert.strictEqual(
				yield* settle(t.signup('down@example.com')),
				'VerificationFailed',
			)
			expect(t.siteverify).toHaveBeenCalledTimes(3)
			expect(t.rows().map((row) => row.email)).toEqual(['retry@example.com'])
		}),
	)

	it.effect(
		'a hung siteverify request is aborted at the timeout, not just abandoned',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const t = setup()
				const aborted: Array<number> = []
				t.siteverify.mockImplementation(
					(_url, init) =>
						new Promise<Response>((_resolve, reject) => {
							init!.signal!.addEventListener('abort', () => {
								aborted.push(t.siteverify.mock.calls.length)
								reject(init!.signal!.reason)
							})
						}),
				)
				const fiber = yield* Effect.forkChild(t.signup('hung@example.com'))
				yield* TestClock.adjust('2999 millis')
				assert.deepStrictEqual(aborted, [])
				yield* TestClock.adjust('1 millis')
				assert.deepStrictEqual(aborted, [1])
				// Backoff 200ms, second 3s attempt, backoff 400ms, third 3s attempt.
				yield* TestClock.adjust('3200 millis')
				assert.deepStrictEqual(aborted, [1, 2])
				yield* TestClock.adjust('3400 millis')
				assert.deepStrictEqual(aborted, [1, 2, 3])
				assert.strictEqual(yield* Fiber.join(fiber), 'VerificationFailed')
			}),
	)

	it.effect(
		'without Turnstile keys a non-production runtime skips the check',
		() =>
			Effect.gen(function* () {
				yield* atStart
				const env = {
					TURNSTILE_SITE_KEY: '',
					TURNSTILE_SECRET_KEY: '',
					SENTRY_ENVIRONMENT: 'test',
				}
				const verification = HumanVerification.layer(env)
				yield* HumanVerification.use((service) =>
					service.verify({
						token: undefined,
						remoteIp: undefined,
						expectedHostname: 'kody.example.com',
					}),
				).pipe(Effect.provide(verification))
			}),
	)

	it.effect('without Turnstile keys production refuses as unavailable', () =>
		Effect.gen(function* () {
			const error = yield* HumanVerification.use((service) =>
				service.verify({
					token: 'token',
					remoteIp: undefined,
					expectedHostname: 'kody.example.com',
				}),
			).pipe(
				Effect.flip,
				Effect.provide(
					HumanVerification.layer({ SENTRY_ENVIRONMENT: 'production' }),
				),
			)
			assert.strictEqual(error._tag, 'VerificationUnavailable')
		}),
	)
})

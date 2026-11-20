import { DatabaseSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { VerificationFailed } from './errors.ts'
import {
	AuditLog,
	ConfirmationMailer,
	HumanVerification,
	NewsletterDb,
	RateLimiter,
	type NewsletterEnv,
} from './services.ts'
import { newsletterSignup, requestNewsletterSignup } from './signup.ts'
import { recordWhatsNewConsentChange } from './consent-outbox.ts'

const now = new Date('2026-11-15T12:00:00.000Z')

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

function env(extra: Record<string, unknown> = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return {
		sqlite,
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			APP_BASE_URL: 'https://kody.example.com',
			SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
			TURNSTILE_SITE_KEY: 'site-key',
			TURNSTILE_SECRET_KEY: 'secret-key',
			...extra,
		} as unknown as NewsletterEnv,
	}
}

const request = () =>
	new Request('https://kody.example.com/newsletter', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.9' },
	})

test('a failed human check stops the sign-up before the database or mailer, with one audit row', async () => {
	const touched: Array<string> = []
	const audited: Array<unknown> = []
	const unreachable = (name: string) => () => {
		touched.push(name)
		return Effect.die(`${name} should not run`)
	}
	const layer = Layer.mergeAll(
		Layer.succeed(
			NewsletterDb,
			NewsletterDb.of({
				first: unreachable('db.first'),
				all: unreachable('db.all'),
				run: unreachable('db.run'),
			}),
		),
		Layer.succeed(
			RateLimiter,
			RateLimiter.of({ allow: () => Effect.succeed(true) }),
		),
		Layer.succeed(
			HumanVerification,
			HumanVerification.of({
				verify: () =>
					Effect.fail(new VerificationFailed({ reason: 'rejected' })),
			}),
		),
		Layer.succeed(
			ConfirmationMailer,
			ConfirmationMailer.of({
				appBaseUrl: unreachable('mailer.appBaseUrl'),
				send: unreachable('mailer.send'),
			}),
		),
		Layer.succeed(
			AuditLog,
			AuditLog.of({
				record: (event) => Effect.sync(() => void audited.push(event)),
			}),
		),
	)

	const error = await newsletterSignup({
		request: request(),
		form: { email: 'reader@example.com' },
		now,
	}).pipe(Effect.flip, Effect.provide(layer), Effect.runPromise)

	expect(error._tag).toBe('VerificationFailed')
	expect(touched).toEqual([])
	expect(audited).toEqual([
		expect.objectContaining({ result: 'failure', reason: 'turnstile' }),
	])
})

test('a siteverify call that never answers fails closed after the timeout', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise<Response>(() => {})),
	)
	const { env: bindings } = env()

	const result = requestNewsletterSignup({
		env: bindings,
		request: request(),
		form: { email: 'reader@example.com', turnstileToken: 'token' },
		now,
	})
	await vi.advanceTimersByTimeAsync(10_000)

	await expect(result).resolves.toEqual({
		ok: false,
		error: 'verification_failed',
	})
})

test('audit writes are handed to waitUntil so they outlive the response', async () => {
	const { env: bindings } = env()
	const waitUntil = vi.fn()

	await requestNewsletterSignup({
		env: bindings,
		request: request(),
		form: { email: 'reader@example.com', kody_hp: 'bot' },
		now,
		waitUntil,
	})

	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ reason: 'honeypot' }),
	)
	expect(waitUntil).toHaveBeenCalledWith(
		logAuditEventSpy.mock.results[0]!.value,
	)
})

test('a queue send that fails once is retried before falling back to the sweep', async () => {
	const queue = {
		send: vi
			.fn<(body: unknown) => Promise<void>>()
			.mockRejectedValueOnce(new Error('queue blip'))
			.mockResolvedValue(undefined),
	}
	const { env: bindings, sqlite } = env({
		PACKAGE_EVENTS_DISPATCH_QUEUE: queue,
	})

	await recordWhatsNewConsentChange({
		env: bindings,
		stableUserId: 'b'.repeat(64),
		optedIn: true,
		source: 'newsletter_page',
		occurredAt: now.toISOString(),
		now,
	})

	expect(queue.send).toHaveBeenCalledTimes(2)
	expect(consoleError).not.toHaveBeenCalled()
	expect(
		sqlite.prepare('SELECT COUNT(*) AS n FROM whats_new_consent_outbox').get(),
	).toEqual({ n: 1 })
})

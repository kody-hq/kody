import { assert, describe, it } from '@effect/vitest'
import { type Duration, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'
import {
	PublicFormProtection,
	siteverifyUrl,
} from '#worker/effect/public-form-protection.ts'

const env = {
	TURNSTILE_SITE_KEY: 'site-key',
	TURNSTILE_SECRET_KEY: 'secret-key',
	SENTRY_ENVIRONMENT: 'production',
}

const form = { turnstileToken: 'single-use-token' }
const request = () =>
	new Request('https://kody.example.com/newsletter', { method: 'POST' })

/** Let pending fetch promises settle so the fiber reaches its next sleep. */
const settle = Effect.promise(
	() => new Promise<void>((resolve) => setTimeout(resolve, 5)),
)

/**
 * Siteverify as Cloudflare documents it: a token redeems once. A repeat with
 * the idempotency key it was redeemed under replays the first answer; any
 * other repeat is refused as `timeout-or-duplicate`.
 */
function siteverifyStub(options: { loseFirstResponse: boolean }) {
	const redeemed = new Map<string, string>()
	const keys: Array<string | null> = []
	let lost = options.loseFirstResponse
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		assert.strictEqual(url, siteverifyUrl)
		const body = init.body as URLSearchParams
		const token = body.get('response')!
		const key = body.get('idempotency_key')
		keys.push(key)
		const firstKey = redeemed.get(token)
		if (firstKey === undefined) {
			redeemed.set(token, key ?? '')
		} else if (!key || key !== firstKey) {
			return Response.json({
				success: false,
				'error-codes': ['timeout-or-duplicate'],
			})
		}
		if (lost) {
			lost = false
			return new Response('upstream reset', { status: 502 })
		}
		return Response.json({ success: true, hostname: 'kody.example.com' })
	})
	return { fetch, keys }
}

const verify = PublicFormProtection.use((protection) =>
	protection.verify({ request: request(), form }),
).pipe(Effect.provide(PublicFormProtection.layer(env)))

describe('Turnstile siteverify retries', () => {
	it.effect(
		'a retry after a lost response reuses the idempotency key and succeeds',
		() =>
			Effect.gen(function* () {
				const stub = siteverifyStub({ loseFirstResponse: true })
				vi.stubGlobal('fetch', stub.fetch)
				const fiber = yield* Effect.forkChild(verify)
				yield* settle
				// The first attempt redeemed the token, then its response was lost.
				assert.strictEqual(stub.fetch.mock.calls.length, 1)
				yield* TestClock.adjust('250 millis')
				yield* settle
				const exit = yield* Fiber.await(fiber)
				assert.isTrue(Exit.isSuccess(exit))
				assert.strictEqual(stub.keys.length, 2)
				assert.match(stub.keys[0]!, /^[0-9a-f-]{36}$/)
				assert.strictEqual(stub.keys[1], stub.keys[0])
			}),
	)

	it.effect('a reused token without the matching key is rejected', () =>
		Effect.gen(function* () {
			const stub = siteverifyStub({ loseFirstResponse: false })
			vi.stubGlobal('fetch', stub.fetch)
			yield* verify
			// A second verification is a fresh key: replaying the token fails.
			const error = yield* Effect.flip(verify)
			assert.strictEqual(error._tag, 'HumanVerificationFailed')
			assert.deepStrictEqual(
				error._tag === 'HumanVerificationFailed' ? error.reason : null,
				'rejected',
			)
			assert.notStrictEqual(stub.keys[0], stub.keys[1])
		}),
	)

	it.effect(
		'each attempt is aborted at its timeout, then the check fails closed',
		() =>
			Effect.gen(function* () {
				const aborted: Array<unknown> = []
				vi.stubGlobal(
					'fetch',
					vi.fn(
						(_url: string, init: RequestInit) =>
							new Promise<Response>((_resolve, reject) => {
								init.signal!.addEventListener('abort', () => {
									aborted.push(init.signal!.reason)
									reject(init.signal!.reason)
								})
							}),
					),
				)
				const fiber = yield* Effect.forkChild(Effect.flip(verify))
				const waits: Array<Duration.Input> = [
					'4 seconds',
					'250 millis',
					'4 seconds',
					'500 millis',
					'4 seconds',
				]
				for (const wait of waits) {
					yield* settle
					yield* TestClock.adjust(wait)
				}
				yield* settle
				const error = yield* Fiber.join(fiber)
				assert.strictEqual(aborted.length, 3)
				assert.strictEqual(
					error._tag === 'HumanVerificationFailed' ? error.reason : null,
					'outage',
				)
			}),
	)

	it.effect('production without keys refuses instead of failing open', () =>
		Effect.gen(function* () {
			const error = yield* PublicFormProtection.use((protection) =>
				protection.verify({ request: request(), form }),
			).pipe(
				Effect.provide(
					PublicFormProtection.layer({ SENTRY_ENVIRONMENT: 'production' }),
				),
				Effect.flip,
			)
			assert.strictEqual(error._tag, 'HumanVerificationUnavailable')
		}),
	)
})

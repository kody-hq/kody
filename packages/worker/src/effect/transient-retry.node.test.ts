import { Clock, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { DatabaseError } from './d1.ts'
import {
	isTransientStorageError,
	retryTransient,
	TransientRetryBudget,
} from './transient-retry.ts'

function flakyCall(failures: Array<string>) {
	let calls = 0
	const effect = Effect.suspend(() => {
		const message = failures[calls++]
		return message === undefined
			? Effect.succeed('ok')
			: Effect.fail(
					new DatabaseError({
						operation: 'test.call',
						reason: 'query',
						message,
						cause: new Error(message),
					}),
				)
	})
	return { effect, calls: () => calls }
}

// One request under TestClock: no real sleeping, and `sleptMs` is the
// backoff the request spent.
async function runRequest<A, E>(
	effect: Effect.Effect<A, E, TransientRetryBudget>,
) {
	const program = Effect.gen(function* () {
		const fiber = yield* Effect.gen(function* () {
			const start = yield* Clock.currentTimeMillis
			const exit = yield* Effect.exit(effect)
			return { exit, sleptMs: (yield* Clock.currentTimeMillis) - start }
		}).pipe(Effect.provide(TransientRetryBudget.layer), Effect.forkChild)
		yield* TestClock.adjust('10 seconds')
		return yield* Fiber.join(fiber)
	}).pipe(Effect.provide(TestClock.layer()))
	return await Effect.runPromise(program)
}

const lost = 'D1_ERROR: Network connection lost.'

test('only the four platform blips are transient', () => {
	for (const message of [
		'Network connection lost.',
		'D1_ERROR: storage operation exceeded timeout which caused object to be reset.',
		'D1_ERROR: internal error; reference = abc',
		'put: We encountered an internal error. Please try again. (10001)',
	]) {
		expect(isTransientStorageError({ message })).toBe(true)
	}
	for (const message of [
		'D1_ERROR: UNIQUE constraint failed: publish_builds.id',
		'D1_ERROR: database is locked',
		'put: Unauthorized (10002)',
	]) {
		expect(isTransientStorageError({ message })).toBe(false)
	}
})

test('a transient failure is retried with 50 then 100 ms of backoff until it succeeds', async () => {
	const call = flakyCall([lost, 'storage operation exceeded timeout'])
	const { exit, sleptMs } = await runRequest(
		retryTransient('test.call', call.effect),
	)
	expect(exit).toEqual(Exit.succeed('ok'))
	expect(call.calls()).toBe(3)
	expect(sleptMs).toBe(150)
})

test('a call is retried three times, then fails as itself', async () => {
	const call = flakyCall([lost, lost, lost, lost])
	const { exit, sleptMs } = await runRequest(
		retryTransient('test.call', call.effect),
	)
	expect(Exit.isFailure(exit)).toBe(true)
	expect(exit).toMatchObject({
		cause: { reasons: [{ error: { _tag: 'DatabaseError', message: lost } }] },
	})
	expect(call.calls()).toBe(4)
	expect(sleptMs).toBe(350)
})

test('a permanent failure is not retried', async () => {
	const call = flakyCall(['D1_ERROR: UNIQUE constraint failed', lost])
	const { exit, sleptMs } = await runRequest(
		retryTransient('test.call', call.effect),
	)
	expect(exit).toMatchObject({
		cause: {
			reasons: [
				{
					error: {
						_tag: 'DatabaseError',
						message: 'D1_ERROR: UNIQUE constraint failed',
					},
				},
			],
		},
	})
	expect(call.calls()).toBe(1)
	expect(sleptMs).toBe(0)
})

test('the budget is per request: calls share it, and a new request starts fresh', async () => {
	const first = flakyCall([lost, lost])
	const second = flakyCall([lost, lost])
	const third = flakyCall([lost, lost])
	const { exit, sleptMs } = await runRequest(
		Effect.all([
			retryTransient('test.first', first.effect),
			retryTransient('test.second', second.effect),
			retryTransient('test.third', third.effect),
		]),
	)
	// 150 + 150 + 50 ms spent; another 100 ms would pass 400.
	expect(exit).toMatchObject({
		cause: {
			reasons: [
				{
					error: {
						_tag: 'TransientRetryBudgetExhausted',
						label: 'test.third',
					},
				},
			],
		},
	})
	expect(sleptMs).toBe(350)
	expect([first.calls(), second.calls(), third.calls()]).toEqual([3, 3, 2])

	const again = flakyCall([lost, lost])
	const retried = await runRequest(retryTransient('test.third', again.effect))
	expect(retried.exit).toEqual(Exit.succeed('ok'))
	expect(retried.sleptMs).toBe(150)
})

test('a call outside any request budget runs once', async () => {
	const call = flakyCall([lost])
	const exit = await Effect.runPromise(
		Effect.exit(retryTransient('test.call', call.effect)),
	)
	expect(Exit.isFailure(exit)).toBe(true)
	expect(call.calls()).toBe(1)
})

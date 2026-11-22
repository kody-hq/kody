import { Effect, Exit, Fiber, Match, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import { runPublishOffload } from '#worker/test-support/publish-offload-effect.ts'
import { outbound } from '#worker/effect/outbound.ts'
import type {
	PublishContextFlagsOff,
	PublishOffloadDisabled,
} from './errors.ts'
import { getPublishBuild } from './store.ts'

test('an outbound call past its deadline fails typed and aborts its signal', async () => {
	let signal: AbortSignal | undefined
	const program = Effect.gen(function* () {
		const fiber = yield* outbound(
			'test.never_answers',
			(abort) => {
				signal = abort
				return new Promise<never>(() => {})
			},
			{ timeout: '2 seconds' },
		).pipe(Effect.flip, Effect.forkChild)
		yield* TestClock.adjust('2 seconds')
		return yield* Fiber.join(fiber)
	}).pipe(Effect.provide(TestClock.layer()))
	const error = await Effect.runPromise(program)
	expect(error).toMatchObject({
		_tag: 'OutboundCallError',
		operation: 'test.never_answers',
		reason: 'timeout',
	})
	expect(signal?.aborted).toBe(true)
})

test('a D1 row that does not match its schema is a typed DatabaseError, not undefined fields', async () => {
	const db = {
		prepare: () => ({
			bind: () => ({ first: async () => ({ id: 'pb_x', status: 'sealed' }) }),
		}),
	} as unknown as D1Database
	const exit = await runPublishOffload(Effect.exit(getPublishBuild('pb_x')), {
		db,
	})
	expect(Exit.isFailure(exit)).toBe(true)
	expect(
		Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit)),
	).toMatchObject({
		_tag: 'DatabaseError',
		operation: 'publish_builds.get',
		reason: 'row_schema',
	})
})

test('an edge mapping that skips a failure does not compile', () => {
	type Failure = PublishOffloadDisabled | PublishContextFlagsOff
	const complete = Match.type<Failure>().pipe(
		Match.tagsExhaustive({
			PublishOffloadDisabled: () => 403,
			PublishContextFlagsOff: () => 403,
		}),
	)
	const incomplete = Match.type<Failure>().pipe(
		// @ts-expect-error PublishContextFlagsOff has no mapping
		Match.tagsExhaustive({ PublishOffloadDisabled: () => 403 }),
	)
	expect(typeof complete).toBe('function')
	expect(typeof incomplete).toBe('function')
})

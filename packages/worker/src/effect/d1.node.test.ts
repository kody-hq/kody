import { DatabaseSync } from 'node:sqlite'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { D1, sql } from '#worker/effect/d1.ts'
import { RateLimiter } from '#worker/effect/rate-limit.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

function database() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, count INTEGER)`)
	sqlite.exec(`INSERT INTO items VALUES ('a', 1), ('b', NULL)`)
	return D1.layer(createD1FromSqlite(sqlite))
}

const Item = Schema.Struct({ id: Schema.String, count: Schema.Int })

describe('D1 reads', () => {
	it.effect('a row that matches its schema decodes', () =>
		Effect.gen(function* () {
			const d1 = yield* D1
			const row = yield* d1.first(
				'items.read',
				Item,
				sql(`SELECT id, count FROM items WHERE id = ?`, 'a'),
			)
			assert.deepStrictEqual(row, Option.some({ id: 'a', count: 1 }))
		}).pipe(Effect.provide(database())),
	)

	it.effect('a drifted row is a typed DatabaseError at the read', () =>
		Effect.gen(function* () {
			const d1 = yield* D1
			const error = yield* Effect.flip(
				d1.all('items.read_all', Item, sql(`SELECT id, count FROM items`)),
			)
			assert.strictEqual(error._tag, 'DatabaseError')
			assert.strictEqual(error.reason, 'row_schema')
			assert.strictEqual(error.operation, 'items.read_all')
		}).pipe(Effect.provide(database())),
	)

	it.effect('a failing statement is a typed DatabaseError', () =>
		Effect.gen(function* () {
			const d1 = yield* D1
			const error = yield* Effect.flip(
				d1.run('items.bad', sql(`INSERT INTO missing VALUES (1)`)),
			)
			assert.strictEqual(error.reason, 'query')
		}).pipe(Effect.provide(database())),
	)
})

describe('RateLimiter', () => {
	const limiter = () => RateLimiter.layer.pipe(Layer.provide(database()))
	const config = { maxRequests: 2, windowSeconds: 60 }

	it.effect(
		'blocks past the limit and frees the slot when the window moves on',
		() =>
			Effect.gen(function* () {
				const rateLimiter = yield* RateLimiter
				const check = rateLimiter.check('key', config)
				assert.isTrue((yield* check).allowed)
				assert.isTrue((yield* check).allowed)
				assert.deepStrictEqual(yield* check, {
					allowed: false,
					retryAfterSeconds: 60,
				})
				yield* TestClock.adjust('61 seconds')
				assert.isTrue((yield* check).allowed)
			}).pipe(Effect.provide(limiter())),
	)

	it.effect('release refunds the latest slot', () =>
		Effect.gen(function* () {
			const rateLimiter = yield* RateLimiter
			const once = { maxRequests: 1, windowSeconds: 60 }
			assert.isTrue((yield* rateLimiter.check('refund', once)).allowed)
			yield* rateLimiter.release('refund')
			assert.isTrue((yield* rateLimiter.check('refund', once)).allowed)
		}).pipe(Effect.provide(limiter())),
	)
})

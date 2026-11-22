import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { withD1Failures } from '#worker/test-support/d1-failures.ts'
import {
	isTransientD1Error,
	TransientD1ItemRetry,
	transientD1ItemRetryEnv,
	TransientRetryBudgetExhausted,
} from './d1-item-retry.ts'

const networkLost = 'D1_ERROR: Network connection lost.'
const codeUpdated =
	'D1_ERROR: Durable Object reset because its code was updated.'

function fakeTime() {
	const sleeps: Array<number> = []
	return {
		sleeps,
		sleep: async (ms: number) => {
			sleeps.push(ms)
		},
	}
}

function failingThen<T>(messages: Array<string>, value: T) {
	let attempts = 0
	return {
		get attempts() {
			return attempts
		},
		operation: async () => {
			attempts += 1
			const message = messages.shift()
			if (message !== undefined) throw new Error(message)
			return value
		},
	}
}

test('transient markers match by substring and everything else is permanent', () => {
	for (const message of [
		networkLost,
		'Durable Object storage operation exceeded timeout which caused object to be reset',
		codeUpdated,
		'D1_ERROR: internal error; reference = abc123',
	])
		expect([message, isTransientD1Error(new Error(message))]).toEqual([
			message,
			true,
		])
	for (const message of [
		'D1_ERROR: UNIQUE constraint failed: orgs.slug',
		'D1_ERROR: database is locked: SQLITE_BUSY',
		'D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
	])
		expect([message, isTransientD1Error(new Error(message))]).toEqual([
			message,
			false,
		])
})

test('a transient error is retried with 100 ms then 200 ms backoff until it succeeds', async () => {
	const time = fakeTime()
	const retry = new TransientD1ItemRetry({ sleep: time.sleep })
	const op = failingThen([networkLost, codeUpdated], 'ok')
	await expect(retry.run(op.operation)).resolves.toBe('ok')
	expect(op.attempts).toBe(3)
	expect(time.sleeps).toEqual([100, 200])
	expect(retry.spentMs).toBe(300)
	expect(retry.exhausted).toBeNull()
})

test('a permanent error is not retried, including by an outer runD1WithRetry', async () => {
	const time = fakeTime()
	const retry = new TransientD1ItemRetry({ sleep: time.sleep })
	const unique = failingThen(['D1_ERROR: UNIQUE constraint failed: x'], 'ok')
	await expect(retry.run(unique.operation)).rejects.toThrow('UNIQUE')
	expect(unique.attempts).toBe(1)
	const busy = failingThen(['D1_ERROR: database is locked: SQLITE_BUSY'], 'ok')
	await expect(runD1WithRetry(() => retry.run(busy.operation))).rejects.toThrow(
		'SQLITE_BUSY',
	)
	expect(busy.attempts).toBe(1)
	expect(time.sleeps).toEqual([])
})

test('a statement retries at most 3 times, then fails with its own error without an outer retry', async () => {
	const time = fakeTime()
	const retry = new TransientD1ItemRetry({ sleep: time.sleep })
	const op = failingThen(
		[networkLost, networkLost, networkLost, networkLost],
		'ok',
	)
	await expect(runD1WithRetry(() => retry.run(op.operation))).rejects.toThrow(
		networkLost,
	)
	expect(op.attempts).toBe(4)
	expect(time.sleeps).toEqual([100, 200, 400])
	expect(retry.exhausted).toBeNull()
})

test('the item budget caps backoff across statements and stays exhausted', async () => {
	const time = fakeTime()
	const retry = new TransientD1ItemRetry({ sleep: time.sleep })
	await retry.run(
		failingThen([networkLost, networkLost, networkLost], 'ok').operation,
	)
	const second = failingThen([networkLost, networkLost, networkLost], 'ok')
	const failure = await retry.run(second.operation).catch((error) => error)
	expect(failure).toBeInstanceOf(TransientRetryBudgetExhausted)
	expect(failure).toMatchObject({ spentMs: 1000, budgetMs: 1000 })
	expect((failure as Error).cause).toEqual(new Error(networkLost))
	expect(second.attempts).toBe(3)
	expect(time.sleeps).toEqual([100, 200, 400, 100, 200])
	expect(retry.exhausted).toBe(failure)
	expect(retry.failure(new Error('wrapped'))).toBe(failure)
	const third = failingThen([networkLost], 'ok')
	await expect(retry.run(third.operation)).rejects.toBe(failure)
	expect(time.sleeps).toHaveLength(5)
	await expect(
		runD1WithRetry(() => retry.run(failingThen([networkLost], 'ok').operation)),
	).rejects.toBe(failure)
})

test('each item retry has its own budget', async () => {
	const time = fakeTime()
	for (const _item of [1, 2]) {
		const retry = new TransientD1ItemRetry({ sleep: time.sleep })
		await retry.run(
			failingThen([networkLost, networkLost, networkLost], 'ok').operation,
		)
		await retry.run(failingThen([networkLost, networkLost], 'ok').operation)
		expect(retry.spentMs).toBe(1000)
		expect(retry.exhausted).toBeNull()
	}
})

test('wrapped bindings retry statements and batches, and attach only through the env resolver', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
	const executions: Array<string> = []
	const db = withD1Failures(
		createD1FromSqlite(sqlite),
		[
			{ matches: (query) => query.startsWith('INSERT'), errors: [networkLost] },
			{ matches: (query) => query.includes(';'), errors: [codeUpdated] },
		],
		executions,
	)
	const time = fakeTime()
	const retry = new TransientD1ItemRetry({ sleep: time.sleep })
	const env = { APP_DB: db } as Env
	const attached = retry.attach(env)
	expect(attached).toEqual(env)
	expect(transientD1ItemRetryEnv(env)).toBe(env)
	const wrapped = transientD1ItemRetryEnv(attached)
	expect(transientD1ItemRetryEnv(wrapped)).toBe(wrapped)
	await wrapped.APP_DB.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`)
		.bind(1, 'a')
		.run()
	await wrapped.APP_DB.batch([
		wrapped.APP_DB.prepare(`UPDATE t SET v = ? WHERE id = ?`).bind('b', 1),
		wrapped.APP_DB.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).bind(2, 'c'),
	])
	expect(sqlite.prepare(`SELECT id, v FROM t ORDER BY id`).all()).toEqual([
		{ id: 1, v: 'b' },
		{ id: 2, v: 'c' },
	])
	expect(executions).toHaveLength(4)
	expect(time.sleeps).toEqual([100, 100])
})

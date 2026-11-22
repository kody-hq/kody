import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createFakeLaneClock,
	transientD1Message,
	withD1Faults,
} from '#worker/test-support/transient-d1-faults.ts'
import {
	TransientRetryBudgetExhausted,
	createTransientD1RetryBudget,
	runInTransientD1RetryScope,
	runWithTransientD1Retry,
	transientD1ErrorMarkers,
	withScopedTransientD1Retry,
	withTransientD1RetryEnv,
	withoutTransientD1Retry,
} from './transient-d1-retry.ts'

function failingOperation(failures: number, message = transientD1Message) {
	let attempts = 0
	const operation = async () => {
		attempts += 1
		if (attempts <= failures) throw new Error(message)
		return 'ok'
	}
	return { operation, attempts: () => attempts }
}

test.each(transientD1ErrorMarkers)(
	'a transient %s error is retried with 100 then 200 ms of backoff until it succeeds',
	async (marker) => {
		const { clock, sleeps } = createFakeLaneClock()
		const budget = createTransientD1RetryBudget()
		const { operation, attempts } = failingOperation(2, `D1_ERROR: ${marker}`)

		await expect(
			runWithTransientD1Retry('APP_DB.run', operation, { clock, budget }),
		).resolves.toBe('ok')
		expect(attempts()).toBe(3)
		expect(sleeps).toEqual([100, 200])
		expect(budget.spentMs).toBe(300)
		expect(budget.exhausted).toBeNull()
	},
)

test.each([
	'D1_ERROR: UNIQUE constraint failed: users.email',
	'D1_ERROR: database is locked: SQLITE_BUSY',
	'D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
])(
	'a permanent %s error is not retried, even by an enclosing runD1WithRetry',
	async (message) => {
		const { clock, sleeps } = createFakeLaneClock()
		const budget = createTransientD1RetryBudget()
		const { operation, attempts } = failingOperation(1, message)

		await expect(
			runD1WithRetry(() =>
				runWithTransientD1Retry('APP_DB.run', operation, { clock, budget }),
			),
		).rejects.toThrow(message)
		expect(attempts()).toBe(1)
		expect(sleeps).toEqual([])
		expect(budget.spentMs).toBe(0)
	},
)

test('a statement retries at most three times, then fails with its own error without an outer retry', async () => {
	const { clock, sleeps } = createFakeLaneClock()
	const budget = createTransientD1RetryBudget()
	const { operation, attempts } = failingOperation(Number.POSITIVE_INFINITY)

	await expect(
		runD1WithRetry(() =>
			runWithTransientD1Retry('APP_DB.run', operation, { clock, budget }),
		),
	).rejects.toThrow(transientD1Message)
	expect(attempts()).toBe(4)
	expect(sleeps).toEqual([100, 200, 400])
	expect(budget.spentMs).toBe(700)
	expect(budget.exhausted).toBeNull()
})

test('the item budget is shared across statements and stops the retry that would exceed 1,000 ms', async () => {
	const { clock, sleeps } = createFakeLaneClock()
	const budget = createTransientD1RetryBudget()
	const first = failingOperation(3)
	const second = failingOperation(3)

	await runWithTransientD1Retry('APP_DB.run', first.operation, {
		clock,
		budget,
	})
	const error = await runWithTransientD1Retry(
		'APP_DB.batch',
		second.operation,
		{
			clock,
			budget,
		},
	).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(TransientRetryBudgetExhausted)
	expect(error).toMatchObject({
		label: 'APP_DB.batch',
		spentMs: 1_000,
		budgetMs: 1_000,
		nextDelayMs: 400,
	})
	expect(budget.exhausted).toBe(error)
	expect(second.attempts()).toBe(3)
	expect(sleeps).toEqual([100, 200, 400, 100, 200])
})

test('each item gets its own budget, so a pass can spend more than 1,000 ms of backoff in total', async () => {
	const { clock, sleeps, elapsedMs } = createFakeLaneClock()
	for (const item of ['first', 'second']) {
		const budget = createTransientD1RetryBudget()
		for (const failures of [3, 2]) {
			const { operation } = failingOperation(failures)
			await expect(
				runWithTransientD1Retry(`APP_DB.${item}`, operation, {
					clock,
					budget,
				}),
			).resolves.toBe('ok')
		}
		expect(budget).toEqual({ budgetMs: 1_000, spentMs: 1_000, exhausted: null })
	}
	expect(sleeps).toEqual([100, 200, 400, 100, 200, 100, 200, 400, 100, 200])
	expect(elapsedMs()).toBe(2_000)
})

test('a wrapped env retries transient D1 statements and batches against the real bindings', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
	const insertFault = {
		target: 'statement',
		failures: 1,
		match: (query: string) => query.startsWith('INSERT'),
	} as const
	const batchFault = {
		target: 'batch',
		failures: 2,
		match: (query: string) => query.startsWith('UPDATE'),
	} as const
	const faults = withD1Faults(createD1FromSqlite(sqlite), [
		insertFault,
		batchFault,
	])
	const { clock, sleeps } = createFakeLaneClock()
	const budget = createTransientD1RetryBudget()
	const env = withTransientD1RetryEnv({ APP_DB: faults.db } as Env, {
		clock,
		budget,
	})

	await env.APP_DB.prepare(`INSERT INTO items (id, name) VALUES (?, ?)`)
		.bind(1, 'before')
		.run()
	await env.APP_DB.batch([
		env.APP_DB.prepare(`UPDATE items SET name = ? WHERE id = ?`).bind(
			'after',
			1,
		),
	])

	expect(faults.attempts(insertFault)).toBe(2)
	expect(faults.attempts(batchFault)).toBe(3)
	expect(sleeps).toEqual([100, 100, 200])
	expect(budget.spentMs).toBe(400)
	expect(sqlite.prepare(`SELECT name FROM items`).all()).toEqual([
		{ name: 'after' },
	])
})

test('shared helpers wrap env only inside an item scope and hand outbound calls the original env', async () => {
	const { clock } = createFakeLaneClock()
	const env = {
		APP_DB: createD1FromSqlite(new DatabaseSync(':memory:')),
	} as Env

	expect(withScopedTransientD1Retry(env)).toBe(env)
	const scoped = await runInTransientD1RetryScope(
		{ clock, budget: createTransientD1RetryBudget() },
		async () => withScopedTransientD1Retry(env),
	)
	expect(scoped).not.toBe(env)
	expect(scoped.APP_DB).not.toBe(env.APP_DB)
	expect(withoutTransientD1Retry(scoped)).toBe(env)
	expect(withTransientD1RetryEnv(scoped, { clock })).toBe(scoped)
})

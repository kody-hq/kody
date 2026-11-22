import { expect, test } from 'vitest'
import { retryBudgetFailure } from './typed-failure.ts'
import {
	createTransientRetryBudget,
	isTransientStorageError,
	TransientRetryBudgetExhaustedError,
	withTransientRetry,
} from './transient-retry.ts'

function recordingBudget() {
	const sleeps: Array<number> = []
	const budget = createTransientRetryBudget(async (ms) => {
		sleeps.push(ms)
	})
	return { budget, sleeps }
}

/** A call that fails with each message in order, then returns `value`. */
function failingThen<T>(messages: Array<string>, value: T) {
	const call = async () => {
		call.attempts += 1
		const message = messages[call.attempts - 1]
		if (message !== undefined) throw new Error(message)
		return value
	}
	call.attempts = 0
	return call
}

test('only the four transient storage markers count as transient', () => {
	for (const message of [
		'D1_ERROR: Network connection lost.',
		'Durable Object storage operation exceeded timeout which caused object to be reset',
		'D1_ERROR: internal error; reference = abc',
		'put: We encountered an internal error. Please try again. (10001)',
	]) {
		expect(isTransientStorageError(new Error(message))).toBe(true)
	}
	for (const message of [
		'D1_ERROR: UNIQUE constraint failed: publish_builds.id',
		'internal error',
		'get: The specified bucket does not exist. (10006)',
	]) {
		expect(isTransientStorageError(new Error(message))).toBe(false)
	}
})

test('a transient error is retried with backoff, then the call succeeds', async () => {
	const { budget, sleeps } = recordingBudget()
	const call = failingThen(
		['D1_ERROR: Network connection lost.', '(10001) internal error'],
		'row',
	)
	await expect(
		withTransientRetry({ label: 'test.get', budget }, call),
	).resolves.toBe('row')
	expect(call.attempts).toBe(3)
	expect(sleeps).toEqual([50, 100])
	expect(budget.remainingMs).toBe(250)
})

test('a permanent error is not retried', async () => {
	const { budget, sleeps } = recordingBudget()
	const call = failingThen(['D1_ERROR: no such table: publish_builds'], 'row')
	await expect(
		withTransientRetry({ label: 'test.get', budget }, call),
	).rejects.toThrow('no such table')
	expect(call.attempts).toBe(1)
	expect(sleeps).toEqual([])
})

test('a call retries at most 3 times and then rethrows the transient error', async () => {
	const { budget, sleeps } = recordingBudget()
	const lost = 'D1_ERROR: Network connection lost.'
	const call = failingThen([lost, lost, lost, lost], 'row')
	await expect(
		withTransientRetry({ label: 'test.get', budget }, call),
	).rejects.toThrow(lost)
	expect(call.attempts).toBe(4)
	expect(sleeps).toEqual([50, 100, 200])
})

test('without a budget the call runs once', async () => {
	const call = failingThen(['D1_ERROR: Network connection lost.'], 'row')
	await expect(withTransientRetry({ label: 'test.get' }, call)).rejects.toThrow(
		'Network connection lost',
	)
	expect(call.attempts).toBe(1)
})

test('the budget is per request: later calls share what earlier calls spent', async () => {
	const lost = 'D1_ERROR: Network connection lost.'
	const { budget, sleeps } = recordingBudget()
	await withTransientRetry(
		{ label: 'test.first', budget },
		failingThen([lost, lost, lost], 'first'),
	)
	expect(budget.remainingMs).toBe(50)
	const second = failingThen([lost, lost], 'second')
	const error = await withTransientRetry(
		{ label: 'test.second', budget },
		second,
	).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(TransientRetryBudgetExhaustedError)
	expect(retryBudgetFailure(error)).toEqual({
		kind: 'transient_retry_budget_exhausted',
		label: 'test.second',
	})
	expect(second.attempts).toBe(2)
	expect(sleeps).toEqual([50, 100, 200, 50])
	// The same call in a fresh request has its own budget and succeeds.
	const fresh = recordingBudget()
	await expect(
		withTransientRetry(
			{ label: 'test.second', budget: fresh.budget },
			failingThen([lost, lost], 'second'),
		),
	).resolves.toBe('second')
	expect(fresh.sleeps).toEqual([50, 100])
})

import { expect, onTestFinished, test, vi } from 'vitest'
import {
	createDetachableAbortSignal,
	hostedExecuteTransportBudgetMs,
	raceWithTransportBudget,
	remainingTransportBudgetMs,
	watchExecuteTransport,
} from './execute-transport-budget.ts'

test('remaining transport budget counts elapsed time and never goes negative', () => {
	expect(
		remainingTransportBudgetMs({
			startedAtMs: 1_000,
			nowMs: 1_000,
			budgetMs: 45_000,
		}),
	).toBe(45_000)
	expect(
		remainingTransportBudgetMs({
			startedAtMs: 1_000,
			nowMs: 11_000,
			budgetMs: 45_000,
		}),
	).toBe(35_000)
	expect(
		remainingTransportBudgetMs({
			startedAtMs: 1_000,
			nowMs: 90_000,
			budgetMs: 45_000,
		}),
	).toBe(0)
	expect(hostedExecuteTransportBudgetMs).toBeLessThan(60_000)
})

test('detachable signal forwards a caller abort until detach', () => {
	const upstream = new AbortController()
	const detachable = createDetachableAbortSignal(upstream.signal)
	expect(detachable.signal.aborted).toBe(false)
	upstream.abort(new DOMException('The operation was aborted', 'AbortError'))
	expect(detachable.signal.aborted).toBe(true)
	expect(detachable.signal.reason).toBeInstanceOf(DOMException)

	const later = new AbortController()
	const detached = createDetachableAbortSignal(later.signal)
	detached.detach()
	later.abort()
	expect(detached.signal.aborted).toBe(false)

	const already = new AbortController()
	already.abort()
	const forwarded = createDetachableAbortSignal(already.signal)
	expect(forwarded.signal.aborted).toBe(true)
	forwarded.detach()
	expect(forwarded.signal.aborted).toBe(true)
})

test('transport budget race prefers a settled or rejected module over the timer', async () => {
	await expect(
		raceWithTransportBudget(Promise.resolve('done'), 0),
	).resolves.toEqual({ kind: 'settled', value: 'done' })
	const failure = new Error('bundle failed')
	await expect(
		raceWithTransportBudget(Promise.reject(failure), 0),
	).resolves.toEqual({ kind: 'rejected', error: failure })
})

test('transport budget race resolves budget while the work promise stays pending', async () => {
	vi.useFakeTimers()
	onTestFinished(() => {
		vi.useRealTimers()
	})
	let resolveWork: (value: string) => void = () => {}
	const work = new Promise<string>((resolve) => {
		resolveWork = resolve
	})
	const raced = raceWithTransportBudget(work, 45_000)
	await vi.advanceTimersByTimeAsync(45_000)
	await expect(raced).resolves.toEqual({ kind: 'budget' })
	resolveWork('late')
	await expect(work).resolves.toBe('late')
})

test('watchExecuteTransport keeps a budget loss pending and records a later settlement', async () => {
	vi.useFakeTimers()
	onTestFinished(() => {
		vi.useRealTimers()
	})
	let resolveWork: (value: string) => void = () => {}
	const work = new Promise<string>((resolve) => {
		resolveWork = resolve
	})
	const watched = watchExecuteTransport(work, 10)
	const pending = watched.raced
	await vi.advanceTimersByTimeAsync(10)
	await expect(pending).resolves.toEqual({ kind: 'budget' })
	expect(watched.peek()).toBeNull()
	resolveWork('finished')
	await vi.advanceTimersByTimeAsync(0)
	expect(watched.peek()).toEqual({ ok: true, value: 'finished' })
})

import { expect, test, vi } from 'vitest'
import {
	memoizeForFeatureFlagExecution,
	runInFeatureFlagExecution,
} from './execution-scope.ts'

test('reads are shared within an execution id and never outside one', async () => {
	const load = vi.fn(async () => true)
	const read = () => memoizeForFeatureFlagExecution('global:x', load)

	await read()
	await runInFeatureFlagExecution(null, read)
	expect(load).toHaveBeenCalledTimes(2)

	await runInFeatureFlagExecution('execution-a', read)
	await runInFeatureFlagExecution('execution-a', read)
	expect(load).toHaveBeenCalledTimes(3)

	await runInFeatureFlagExecution('execution-b', read)
	expect(load).toHaveBeenCalledTimes(4)
})

test('a failed read is not kept for the execution', async () => {
	const load = vi
		.fn<() => Promise<boolean>>()
		.mockRejectedValueOnce(new Error('D1 blip'))
		.mockResolvedValueOnce(true)
	const read = () =>
		runInFeatureFlagExecution('execution-retry', () =>
			memoizeForFeatureFlagExecution('global:y', load),
		)

	await expect(read()).rejects.toThrow('D1 blip')
	await expect(read()).resolves.toBe(true)
	await expect(read()).resolves.toBe(true)
	expect(load).toHaveBeenCalledTimes(2)
})

test('a gateway call never awaits a read another call still has in flight', async () => {
	let resolveFirst!: (value: boolean) => void
	const load = vi
		.fn<() => Promise<boolean>>()
		.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (resolveFirst = resolve)),
		)
		.mockResolvedValue(false)
	const gatewayCall = () =>
		runInFeatureFlagExecution('execution-concurrent', () =>
			memoizeForFeatureFlagExecution('global:z', load),
		)

	const first = gatewayCall()
	const second = gatewayCall()
	expect(second).not.toBe(first)
	expect(load).toHaveBeenCalledTimes(2)
	await expect(second).resolves.toBe(false)

	resolveFirst(true)
	await expect(first).resolves.toBe(true)
	// The latest settled value is shared with later calls in the execution.
	await expect(gatewayCall()).resolves.toBe(true)
	expect(load).toHaveBeenCalledTimes(2)
})

test('reads within one gateway call share the in-flight load', async () => {
	const load = vi.fn(async () => true)
	await runInFeatureFlagExecution('execution-one-call', async () => {
		const [a, b] = await Promise.all([
			memoizeForFeatureFlagExecution('global:w', load),
			memoizeForFeatureFlagExecution('global:w', load),
		])
		expect([a, b]).toEqual([true, true])
	})
	expect(load).toHaveBeenCalledTimes(1)
})

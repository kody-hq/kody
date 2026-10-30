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

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	countDynamicWorkerModuleGraphChars,
	countEvaluateInvocationParamsChars,
	recordDynamicWorkerInvoke,
} from './dynamic-worker-invoke.ts'

test('countEvaluateInvocationParamsChars is the key-sorted JSON length or 0', () => {
	expect(countEvaluateInvocationParamsChars({ z: 1, a: 2 })).toBe(
		'{"a":2,"z":1}'.length,
	)
	expect(countEvaluateInvocationParamsChars({ z: { b: 1, a: 2 }, a: 0 })).toBe(
		'{"a":0,"z":{"a":2,"b":1}}'.length,
	)

	expect(countEvaluateInvocationParamsChars({})).toBe(0)
	expect(countEvaluateInvocationParamsChars(null)).toBe(0)
	expect(countEvaluateInvocationParamsChars([])).toBe(0)
	expect(countEvaluateInvocationParamsChars([1, { z: 1, a: 2 }])).toBe(0)
})

test('countDynamicWorkerModuleGraphChars sums text only and ignores names', () => {
	expect(
		countDynamicWorkerModuleGraphChars({
			'secret-package.js': 'abcd',
			'harness.js': { js: 'ef', cjs: 'gh', text: 'ij' },
			'binary.wasm': { data: new ArrayBuffer(32) },
			'config.json': { json: { token: 'nope' } },
		}),
	).toBe(10)
})

test('recordDynamicWorkerInvoke writes numbers and closed enums only', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)

	await recordDynamicWorkerInvoke({
		env: {},
		userId: ownerIdFromStored('user-1'),
		durationMs: 15,
		outcome: 'success',
		surface: 'execute',
		cacheReuse: 'miss',
		codeChars: 40,
		executeShape: 'thin_few_exports',
		paramsChars: 13,
	})

	expect(recordUsageSpy).toHaveBeenCalledTimes(1)
	expect(recordUsageSpy.mock.calls[0]?.[1]).toEqual({
		userId: ownerIdFromStored('user-1'),
		eventType: 'dynamic_worker_invoke',
		durationMs: 15,
		outcome: 'success',
		surface: 'execute',
		cacheReuse: 'miss',
		codeChars: 40,
		paramsChars: 13,
		executeShape: 'thin_few_exports',
	})
	recordUsageSpy.mockRestore()
})

test('recordDynamicWorkerInvoke skips anonymous runs and never throws', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const spy = vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	consoleWarn.mockImplementation(() => {})

	await recordDynamicWorkerInvoke({
		env: {},
		userId: null,
		durationMs: 1,
		outcome: 'success',
		surface: 'job',
		cacheReuse: 'hit',
		codeChars: 1,
	})
	spy.mockRejectedValueOnce(new Error('usage exploded'))
	await recordDynamicWorkerInvoke({
		env: {},
		userId: ownerIdFromStored('user-1'),
		durationMs: 1,
		outcome: 'error',
		surface: 'job',
		cacheReuse: 'hit',
		codeChars: 1,
	})

	expect(spy).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'dynamic-worker-invoke-record-failed',
		expect.any(Error),
	)
	spy.mockRestore()
})

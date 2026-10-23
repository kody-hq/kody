import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { recordUniqueDynamicWorkerDay } from './dynamic-worker-day.ts'

test('recordUniqueDynamicWorkerDay records the first claim and skips repeats', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const meter = createInMemoryUserMeterEnv()
	const now = new Date('2026-09-01T12:00:00.000Z')

	const first = await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: ownerIdFromStored('user-1'),
		workerId: 'kody-worker-a',
		surface: 'execute',
		now,
	})
	const repeat = await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: ownerIdFromStored('user-1'),
		workerId: 'kody-worker-a',
		surface: 'job',
		now,
	})
	const other = await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: ownerIdFromStored('user-1'),
		workerId: 'kody-worker-b',
		surface: 'package_export',
		connectionKey: 'api-token:person-1:tok-1',
		now,
	})
	expect(first).toEqual({ created: true })
	expect(repeat).toEqual({ created: false })
	expect(other).toEqual({ created: true })

	expect(recordUsageSpy).toHaveBeenCalledTimes(2)
	expect(recordUsageSpy.mock.calls[0]?.[1]).toEqual({
		userId: ownerIdFromStored('user-1'),
		eventType: 'dynamic_worker_day',
		entityId: 'kody-worker-a',
		outcome: 'success',
		timestamp: now.toISOString(),
		surface: 'execute',
	})
	expect(recordUsageSpy.mock.calls[1]?.[1]).toEqual({
		userId: ownerIdFromStored('user-1'),
		eventType: 'dynamic_worker_day',
		entityId: 'kody-worker-b',
		outcome: 'success',
		timestamp: now.toISOString(),
		surface: 'package_export',
		connectionKey: 'api-token:person-1:tok-1',
	})
	recordUsageSpy.mockRestore()
})

test('recordUniqueDynamicWorkerDay skips anonymous runs and never throws', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const spy = vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const meter = createInMemoryUserMeterEnv()
	consoleWarn.mockImplementation(() => {})

	await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: null,
		workerId: 'kody-worker-a',
		surface: 'execute',
	})
	await recordUniqueDynamicWorkerDay({
		env: {
			USER_METER: {
				idFromName() {
					throw new Error('meter exploded')
				},
				get() {
					throw new Error('meter exploded')
				},
			} as unknown as DurableObjectNamespace,
		},
		userId: ownerIdFromStored('user-1'),
		workerId: 'kody-worker-a',
		surface: 'job',
	})

	expect(spy).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'dynamic-worker-day-record-failed',
		expect.any(Error),
	)
	spy.mockRestore()
})

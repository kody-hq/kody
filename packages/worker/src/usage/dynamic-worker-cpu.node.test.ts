import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./record-usage.ts', () => ({ recordUsage }))

import { recordDynamicWorkerCpu } from './dynamic-worker-cpu.ts'

const props = { userId: ownerIdFromStored('user-1'), workerId: 'dw_abc' }
const usageEnv = { USAGE_EVENTS: { writeDataPoint() {} } }

test('records the platform cpuTime, with wall time only as duration', async () => {
	await recordDynamicWorkerCpu({
		env: usageEnv as never,
		props,
		event: { cpuTime: 12.6, wallTime: 830.2, outcome: 'ok' },
	})
	expect(recordUsage).toHaveBeenCalledWith(usageEnv, {
		userId: ownerIdFromStored('user-1'),
		eventType: 'dynamic_worker_cpu',
		entityId: 'dw_abc',
		cpuMs: 12.6,
		durationMs: 830,
		outcome: 'success',
	})
})

test('failed invocations record as errors and zero CPU still counts delivery', async () => {
	await recordDynamicWorkerCpu({
		env: usageEnv as never,
		props,
		event: { cpuTime: 0, wallTime: 5, outcome: 'exceededCpu' },
	})
	expect(recordUsage).toHaveBeenCalledWith(
		usageEnv,
		expect.objectContaining({ cpuMs: 0, outcome: 'error' }),
	)
})

test('missing users, non-numeric CPU, and no Analytics Engine are skipped', async () => {
	await recordDynamicWorkerCpu({
		env: {} as never,
		props,
		event: { cpuTime: 4, wallTime: 5, outcome: 'ok' },
	})
	await recordDynamicWorkerCpu({
		env: usageEnv as never,
		props: { userId: '' as OwnerId, workerId: 'dw_abc' },
		event: { cpuTime: 4, wallTime: 5, outcome: 'ok' },
	})
	await recordDynamicWorkerCpu({
		env: usageEnv as never,
		props,
		event: { cpuTime: Number.NaN, wallTime: 5, outcome: 'ok' },
	})
	expect(recordUsage).not.toHaveBeenCalled()
})

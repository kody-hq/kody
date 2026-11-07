import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./record-usage.ts', () => ({ recordUsage }))

const recordPackageAppCpuSampleRpc = vi.hoisted(() =>
	vi.fn(async (_sample: unknown) => undefined),
)
const runLogRpc = vi.hoisted(() =>
	vi.fn((_input: unknown) => ({
		recordPackageAppCpuSample: recordPackageAppCpuSampleRpc,
	})),
)

vi.mock('#worker/run-records/service.ts', () => ({ runLogRpc }))

import {
	packageAppCpuSampleChannel,
	packageAppCpuSampleFromTrace,
	recordDynamicWorkerCpu,
	recordPackageAppCpuSample,
} from './dynamic-worker-cpu.ts'

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

const packageAppProps = {
	userId: ownerIdFromStored('user-1'),
	workerId: 'pa_abc',
	packageApp: { packageId: 'pkg-1', packageName: 'my-app' },
}
const requestId = '0b6f2c1e-7a4d-4c3b-9e1f-2a3b4c5d6e7f'

function packageAppTrace(input: {
	marker?: { cold: boolean; requestId: string } | null
}) {
	return {
		cpuTime: 7.25,
		wallTime: 412.5,
		outcome: 'ok',
		eventTimestamp: Date.parse('2026-11-07T12:00:00.000Z'),
		event: {
			request: {
				url: 'https://app.example/dashboard?secret=1',
				method: 'GET',
				headers: {},
			},
			response: { status: 200 },
		},
		diagnosticsChannelEvents: input.marker
			? [
					{
						channel: packageAppCpuSampleChannel,
						message: input.marker,
						timestamp: 0,
					},
				]
			: [],
	} as never
}

test('package-app trace with a sample marker becomes a sample, path without query', () => {
	expect(
		packageAppCpuSampleFromTrace({
			props: packageAppProps,
			event: packageAppTrace({ marker: { cold: true, requestId } }),
		}),
	).toEqual({
		requestId,
		occurredAt: '2026-11-07T12:00:00.000Z',
		packageId: 'pkg-1',
		packageName: 'my-app',
		cold: true,
		cpuMs: 7.25,
		wallMs: 412.5,
		path: '/dashboard',
		status: 200,
		outcome: 'ok',
	})
})

test('unsampled or malformed package-app traces are skipped', () => {
	expect(
		packageAppCpuSampleFromTrace({
			props: packageAppProps,
			event: packageAppTrace({ marker: null }),
		}),
	).toBeNull()
	expect(
		packageAppCpuSampleFromTrace({
			props: packageAppProps,
			event: packageAppTrace({ marker: { cold: false, requestId: 'nope' } }),
		}),
	).toBeNull()
	expect(
		packageAppCpuSampleFromTrace({
			props,
			event: packageAppTrace({ marker: { cold: true, requestId } }),
		}),
	).toBeNull()
})

test('package-app samples go to the RunLog and never to usage metering', async () => {
	recordUsage.mockClear()
	await recordPackageAppCpuSample({
		env: usageEnv as never,
		props: packageAppProps,
		event: packageAppTrace({ marker: { cold: false, requestId } }),
	})
	expect(recordUsage).not.toHaveBeenCalled()
	expect(runLogRpc).toHaveBeenCalledWith({
		env: usageEnv,
		userId: ownerIdFromStored('user-1'),
	})
	expect(recordPackageAppCpuSampleRpc).toHaveBeenCalledWith(
		expect.objectContaining({ requestId, cold: false, cpuMs: 7.25 }),
	)
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as RecordUsage from './record-usage.ts'

const recordUsage = vi.hoisted(() =>
	vi.fn<typeof RecordUsage.recordUsage>(async () => undefined),
)
const waitUntilImpl = vi.hoisted(() => vi.fn())

vi.mock('./record-usage.ts', () => ({
	recordUsage,
}))

vi.mock('cloudflare:workers', () => ({
	waitUntil: (...args: Array<unknown>) => waitUntilImpl(...args),
}))

import {
	createMeteredDurableObjectStub,
	durableObjectUsageMaxBurstMs,
	flushDurableObjectUsageWrites,
	queueDurableObjectRowsRead,
} from './durable-object-usage.ts'

const analyticsEnv = { USAGE_EVENTS: { writeDataPoint() {} } }

function meter<T extends object>(stub: T, env: object = analyticsEnv) {
	return createMeteredDurableObjectStub({
		env,
		userId: ownerIdFromStored('user-1'),
		doClass: 'StorageRunner',
		stub,
	})
}

const pingStub = {
	async ping() {
		return 'pong'
	},
}

test('createMeteredDurableObjectStub coalesces same-outcome RPC wall-clock', async () => {
	const stub = {
		async ping(label: string) {
			return `pong:${label}`
		},
		async fail() {
			throw new Error('rpc failed')
		},
	}
	const env = analyticsEnv
	const metered = meter(stub)

	await expect(metered.ping('ok')).resolves.toBe('pong:ok')
	await expect(metered.ping('again')).resolves.toBe('pong:again')
	await expect(metered.fail()).rejects.toThrow('rpc failed')
	expect(recordUsage).not.toHaveBeenCalled()

	await flushDurableObjectUsageWrites()
	expect(recordUsage).toHaveBeenCalledTimes(2)
	expect(recordUsage).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			eventType: 'durable_object_gb_seconds',
			entityId: 'StorageRunner',
			eventCount: 2,
			outcome: 'success',
		}),
	)
	expect(recordUsage).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			eventType: 'durable_object_gb_seconds',
			entityId: 'StorageRunner',
			eventCount: 1,
			outcome: 'error',
		}),
	)
	const successDuration = (
		recordUsage.mock.calls.find(
			(call) => (call[1] as { outcome: string }).outcome === 'success',
		)![1] as { durationMs: number }
	).durationMs
	expect(successDuration).toBeGreaterThanOrEqual(0)
})

test('durable object usage keeps non-package and anonymous visitor buckets distinct', async () => {
	recordUsage.mockClear()
	const input = {
		env: analyticsEnv,
		eventType: 'durable_object_rows_read' as const,
		userId: ownerIdFromStored('user-1'),
		doClass: 'StorageRunner',
		rowsRead: 1,
		packageId: 'pkg-1',
	}
	queueDurableObjectRowsRead(input)
	queueDurableObjectRowsRead({
		...input,
		packageAppVisitorUserId: '',
	})

	await flushDurableObjectUsageWrites()

	expect(recordUsage).toHaveBeenCalledTimes(2)
	expect(
		recordUsage.mock.calls.some(
			([, event]) =>
				(event as { packageAppVisitorUserId?: string })
					.packageAppVisitorUserId === '',
		),
	).toBe(true)
	expect(
		recordUsage.mock.calls.some(
			([, event]) => !Object.hasOwn(event as object, 'packageAppVisitorUserId'),
		),
	).toBe(true)
})

test('createMeteredDurableObjectStub never fails the RPC when waitUntil throws', async () => {
	recordUsage.mockClear()
	waitUntilImpl.mockImplementation(() => {
		throw new Error('no invocation context')
	})
	const metered = meter(pingStub)
	await expect(metered.ping()).resolves.toBe('pong')
	await expect(metered.ping()).resolves.toBe('pong')
	expect(waitUntilImpl).toHaveBeenCalledTimes(2)
	await flushDurableObjectUsageWrites()
	expect(recordUsage).toHaveBeenCalledTimes(1)
	waitUntilImpl.mockReset()
})

test('createMeteredDurableObjectStub flushes a burst that never goes idle', async () => {
	recordUsage.mockClear()
	vi.useFakeTimers()
	const metered = meter(pingStub)
	await metered.ping()
	for (let elapsed = 0; elapsed < durableObjectUsageMaxBurstMs; elapsed += 20) {
		await vi.advanceTimersByTimeAsync(20)
		await metered.ping()
	}
	expect(recordUsage).toHaveBeenCalledTimes(1)
	expect(
		(recordUsage.mock.calls[0]![1] as { eventCount: number }).eventCount,
	).toBeGreaterThan(2)
	await flushDurableObjectUsageWrites()
	vi.useRealTimers()
})

test('createMeteredDurableObjectStub binds Rpc methods to the real stub, not the wrapper Proxy', async () => {
	recordUsage.mockClear()
	const stub = {
		get ping() {
			return async () => {
				if (this !== stub) {
					throw new Error(
						"Proxy could not be serialized because it is not a valid RPC receiver type. The Proxy must emulate either a plain object or an RpcTarget, as indicated by the Proxy's prototype chain.",
					)
				}
				return 'pong'
			}
		},
	}
	const metered = meter(stub)
	expect(metered).not.toBe(stub)
	await expect(metered.ping()).resolves.toBe('pong')
	await flushDurableObjectUsageWrites()
	expect(recordUsage).toHaveBeenCalledTimes(1)
})

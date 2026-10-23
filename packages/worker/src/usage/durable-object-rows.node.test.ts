import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./record-usage.ts', () => ({
	recordUsage,
}))

vi.mock('cloudflare:workers', () => ({
	waitUntil: vi.fn(),
}))

import {
	recordDurableObjectPlatformRowsRead,
	recordDurableObjectRowsRead,
} from './durable-object-rows.ts'
import { flushDurableObjectUsageWrites } from './durable-object-usage.ts'

test('without Analytics Engine each read records directly with the truncated count', () => {
	recordDurableObjectRowsRead({
		env: {},
		userId: ownerIdFromStored('user-1'),
		doClass: 'StorageRunner',
		rowsRead: 12.9,
	})
	expect(recordUsage).toHaveBeenCalledWith(
		{},
		{
			userId: ownerIdFromStored('user-1'),
			eventType: 'durable_object_rows_read',
			entityId: 'StorageRunner',
			eventCount: 12,
			outcome: 'success',
		},
	)
})

test('platform rows-read needs Analytics Engine (no per-statement D1 fallback)', () => {
	recordDurableObjectPlatformRowsRead({
		env: {},
		userId: ownerIdFromStored('user-1'),
		doClass: 'RunLog',
		rowsRead: 40,
	})
	expect(recordUsage).not.toHaveBeenCalled()
})

test('with Analytics Engine a burst of reads writes one point per metric and class', async () => {
	const env = { USAGE_EVENTS: { writeDataPoint() {} } }
	for (let index = 0; index < 300; index += 1) {
		recordDurableObjectRowsRead({
			env,
			userId: ownerIdFromStored('user-1'),
			doClass: 'StorageRunner',
			rowsRead: 2,
		})
	}
	recordDurableObjectPlatformRowsRead({
		env,
		userId: ownerIdFromStored('user-1'),
		doClass: 'RunLog',
		rowsRead: 40,
	})
	recordDurableObjectPlatformRowsRead({
		env,
		userId: ownerIdFromStored('user-1'),
		doClass: 'RunLog',
		rowsRead: 2,
	})
	expect(recordUsage).not.toHaveBeenCalled()

	await flushDurableObjectUsageWrites()
	expect(recordUsage).toHaveBeenCalledTimes(2)
	expect(recordUsage).toHaveBeenCalledWith(env, {
		userId: ownerIdFromStored('user-1'),
		eventType: 'durable_object_rows_read',
		entityId: 'StorageRunner',
		eventCount: 600,
		outcome: 'success',
		timestamp: expect.any(String),
	})
	expect(recordUsage).toHaveBeenCalledWith(env, {
		userId: ownerIdFromStored('user-1'),
		eventType: 'durable_object_platform_rows_read',
		entityId: 'RunLog',
		eventCount: 42,
		outcome: 'success',
		timestamp: expect.any(String),
	})
})

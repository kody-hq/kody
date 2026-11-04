import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	acquireScheduledLaneLease,
	releaseScheduledLaneLease,
} from './scheduled-lane-lease.ts'
import { runScheduledLaneWithFailureIsolation } from './scheduled-lanes.ts'

const testEnv = env as Env & { TEST_MIGRATIONS: Array<D1Migration> }
const lane = 'reconcile_artifacts_pushes'

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
})

beforeEach(async () => {
	await testEnv.APP_DB.prepare('DELETE FROM scheduled_lane_leases').run()
})

test('a held lane lease blocks a second holder until it expires or is released', async () => {
	const now = new Date('2026-11-04T08:00:00.000Z')
	const acquire = (holder: string, at: Date) =>
		acquireScheduledLaneLease(testEnv.APP_DB, {
			lane,
			holder,
			leaseMs: 60_000,
			now: at,
		})
	expect(await acquire('first', now)).toBe(true)
	expect(await acquire('second', new Date(now.getTime() + 30_000))).toBe(false)
	// Only the holder can release.
	await releaseScheduledLaneLease(testEnv.APP_DB, { lane, holder: 'second' })
	expect(await acquire('second', new Date(now.getTime() + 30_000))).toBe(false)
	// A killed holder never releases; the lease lapses on its own.
	expect(await acquire('second', new Date(now.getTime() + 60_000))).toBe(true)
	await releaseScheduledLaneLease(testEnv.APP_DB, { lane, holder: 'second' })
	expect(await acquire('third', new Date(now.getTime() + 61_000))).toBe(true)
})

test('an overlapping tick skips while the previous tick holds the lane lease', async () => {
	await testEnv.APP_DB.prepare(
		`INSERT INTO scheduled_lane_leases (lane, holder, expires_at) VALUES (?, ?, ?)`,
	)
		.bind(lane, 'running-tick', new Date(Date.now() + 60_000).toISOString())
		.run()
	consoleWarn.mockImplementation(() => {})
	{
		const outcome = await runScheduledLaneWithFailureIsolation({
			env: testEnv,
			message: { lane, scheduledTime: Date.now(), cron: '*/5 * * * *' },
		})
		expect(outcome).toBe('completed')
		expect(consoleWarn).toHaveBeenCalledWith(
			'scheduled_lane_skipped_overlap',
			expect.objectContaining({ lane }),
		)
		// The lane body never ran, and the running tick still holds the lease.
		expect(consoleInfo).not.toHaveBeenCalledWith(
			'reconcile_artifacts_pushes',
			expect.anything(),
		)
		const row = await testEnv.APP_DB.prepare(
			'SELECT holder FROM scheduled_lane_leases WHERE lane = ?',
		)
			.bind(lane)
			.first<{ holder: string }>()
		expect(row?.holder).toBe('running-tick')
	}
})

test('a tick releases its lane lease when it finishes', async () => {
	{
		const outcome = await runScheduledLaneWithFailureIsolation({
			env: testEnv,
			message: { lane, scheduledTime: Date.now(), cron: '*/5 * * * *' },
		})
		expect(outcome).toBe('completed')
		expect(consoleInfo).toHaveBeenCalledWith(
			'reconcile_artifacts_pushes',
			expect.objectContaining({ checked: 0 }),
		)
	}
	const row = await testEnv.APP_DB.prepare(
		'SELECT holder FROM scheduled_lane_leases WHERE lane = ?',
	)
		.bind(lane)
		.first()
	expect(row).toBeNull()
})

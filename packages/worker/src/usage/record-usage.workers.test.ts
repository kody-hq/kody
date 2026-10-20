import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	recordUsage,
	usageEventBlobIndexes,
	usageEventDoubleIndexes,
} from './record-usage.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

async function listRollups(db: D1Database, userId: string) {
	const { results } = await db
		.prepare(
			`SELECT user_id, metric, month, event_count, error_count,
				total_duration_ms, total_cpu_ms, total_bytes
			FROM usage_rollups WHERE user_id = ?1
			ORDER BY metric, month`,
		)
		.bind(userId)
		.all()
	return results
}

type UsageEvent = Parameters<typeof recordUsage>[1]

function capturingUsageEnv() {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	return {
		dataPoints,
		usageEnv: {
			APP_DB: env.APP_DB,
			USAGE_EVENTS: {
				writeDataPoint(point?: AnalyticsEngineDataPoint) {
					if (point) dataPoints.push(point)
				},
			},
		},
	}
}

async function recordAll(
	usageEnv: Parameters<typeof recordUsage>[0],
	events: Array<UsageEvent>,
) {
	for (const event of events) await recordUsage(usageEnv, event)
}

const blobRow = (userId: string, blobs: Array<string>) => {
	const padded = [userId, ...blobs]
	while (padded.length < 13) padded.push('')
	if (!padded[usageEventBlobIndexes.actorUserId]) {
		padded[usageEventBlobIndexes.actorUserId] = userId
	}
	return padded
}

function dataPoint(
	userId: string,
	blobs: Array<string>,
	doubles: Array<number>,
) {
	return { indexes: [userId], blobs: blobRow(userId, blobs), doubles }
}

function rollup(
	user_id: string,
	metric: string,
	month: string,
	counts: {
		event_count: number
		error_count?: number
		total_duration_ms?: number
		total_bytes?: number
	},
) {
	return {
		user_id,
		metric,
		month,
		error_count: 0,
		total_duration_ms: 0,
		total_cpu_ms: 0,
		total_bytes: 0,
		...counts,
	}
}

function julyExecuteEvents(userA: string, userB: string): Array<UsageEvent> {
	return [
		{
			userId: userA,
			eventType: 'execute',
			durationMs: 120,
			outcome: 'success',
			timestamp: '2026-07-05T10:00:00.000Z',
		},
		{
			userId: userA,
			eventType: 'execute',
			entityId: 'pkg-1',
			durationMs: 80,
			bytes: 512,
			outcome: 'error',
			timestamp: '2026-07-05T11:00:00.000Z',
		},
		{
			userId: userB,
			eventType: 'execute',
			durationMs: 40,
			outcome: 'success',
			timestamp: '2026-07-05T12:00:00.000Z',
		},
		{
			userId: userA,
			eventType: 'durable_object_gb_seconds',
			entityId: 'StorageRunner',
			durationMs: 10_000,
			eventCount: 8,
			outcome: 'success',
			timestamp: '2026-07-05T12:30:00.000Z',
		},
	]
}

test('recordUsage writes only Analytics Engine data points when USAGE_EVENTS is bound', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userA = `usage-user-a-${crypto.randomUUID()}`
	const userB = `usage-user-b-${crypto.randomUUID()}`
	const { dataPoints, usageEnv } = capturingUsageEnv()

	await recordAll(usageEnv, julyExecuteEvents(userA, userB))

	expect(dataPoints).toEqual([
		dataPoint(
			userA,
			['execute', '', 'success', '2026-07-05T10:00:00.000Z'],
			[120, 0, 0, 0, 0],
		),
		dataPoint(
			userA,
			['execute', 'pkg-1', 'error', '2026-07-05T11:00:00.000Z'],
			[80, 0, 512, 0, 0],
		),
		expect.objectContaining({ indexes: [userB] }),
		dataPoint(
			userA,
			[
				'durable_object_gb_seconds',
				'StorageRunner',
				'success',
				'2026-07-05T12:30:00.000Z',
			],
			[10_000, 0, 8, 0, 0],
		),
	])

	// Production path: usage_rollups is a derived aggregate recomputed by the
	// hourly aggregation cron, never written per event.
	expect(await listRollups(env.APP_DB, userA)).toEqual([])
	expect(await listRollups(env.APP_DB, userB)).toEqual([])
})

test('recordUsage accumulates per-user monthly rollups without USAGE_EVENTS (local dev)', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userA = `usage-user-a-${crypto.randomUUID()}`
	const userB = `usage-user-b-${crypto.randomUUID()}`

	await recordAll({ APP_DB: env.APP_DB }, [
		...julyExecuteEvents(userA, userB),
		{
			userId: userA,
			eventType: 'email_send',
			entityId: 'message-1',
			bytes: 2048,
			outcome: 'success',
			timestamp: '2026-08-01T00:00:00.000Z',
		},
	])

	expect(await listRollups(env.APP_DB, userA)).toEqual([
		rollup(userA, 'durable_object_gb_seconds', '2026-07', {
			event_count: 8,
			total_duration_ms: 10_000,
		}),
		rollup(userA, 'email_send', '2026-08', {
			event_count: 1,
			total_bytes: 2048,
		}),
		rollup(userA, 'execute', '2026-07', {
			event_count: 2,
			error_count: 1,
			total_duration_ms: 200,
			total_bytes: 512,
		}),
	])
	// Cross-user isolation: user B only ever sees their own single event.
	expect(await listRollups(env.APP_DB, userB)).toEqual([
		rollup(userB, 'execute', '2026-07', {
			event_count: 1,
			total_duration_ms: 40,
		}),
	])
})

test('recordUsage never throws when bindings are missing, sinks fail, or userId is empty', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userId = `usage-degrade-user-${crypto.randomUUID()}`

	// No bindings at all (local dev / test without Analytics Engine).
	await expect(
		recordUsage({}, { userId, eventType: 'execute', outcome: 'success' }),
	).resolves.toBeUndefined()

	// Analytics Engine sink throws: degrade, don't throw, and never fall back
	// to the per-event D1 upsert (production must not write rollups inline).
	await expect(
		recordUsage(
			{
				APP_DB: env.APP_DB,
				USAGE_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics engine unavailable')
					},
				},
			},
			{
				userId,
				eventType: 'job_run',
				entityId: 'job-1',
				durationMs: 10,
				outcome: 'success',
				timestamp: '2026-07-05T10:00:00.000Z',
			},
		),
	).resolves.toBeUndefined()
	expect(await listRollups(env.APP_DB, userId)).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-event-analytics-failed',
		expect.any(Error),
	)

	// Missing userId: skipped entirely, no row written.
	await expect(
		recordUsage(
			{ APP_DB: env.APP_DB },
			{
				userId: '' as OwnerId,
				eventType: 'execute',
				outcome: 'success',
			},
		),
	).resolves.toBeUndefined()
	expect(await listRollups(env.APP_DB, '')).toEqual([])

	// Rollup table missing (pre-migration database): degrade, don't throw.
	await env.APP_DB.prepare('DROP TABLE usage_rollups').run()
	await expect(
		recordUsage(
			{ APP_DB: env.APP_DB },
			{ userId, eventType: 'execute', outcome: 'success' },
		),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-rollup-failed',
		expect.any(Error),
	)
})

test('recordUsage writes surface and executeShape as trailing Analytics Engine blobs', async () => {
	const userId = `usage-surface-${crypto.randomUUID()}`
	const { dataPoints, usageEnv } = capturingUsageEnv()

	await recordAll(usageEnv, [
		{
			userId,
			eventType: 'dynamic_worker_day',
			entityId: 'kody-worker-a',
			outcome: 'success',
			timestamp: '2026-09-01T12:00:00.000Z',
			surface: 'job',
		},
		{
			userId,
			eventType: 'execute',
			outcome: 'success',
			timestamp: '2026-09-01T12:01:00.000Z',
			surface: 'execute',
			executeShape: 'thin_single_export',
		},
	])

	expect(dataPoints.map((point) => point.blobs)).toEqual([
		blobRow(userId, [
			'dynamic_worker_day',
			'kody-worker-a',
			'success',
			'2026-09-01T12:00:00.000Z',
			'job',
		]),
		blobRow(userId, [
			'execute',
			'',
			'success',
			'2026-09-01T12:01:00.000Z',
			'execute',
			'thin_single_export',
		]),
	])
})

test('recordUsage writes cacheReuse, codeChars, and paramsChars on invoke events', async () => {
	const userId = `usage-invoke-${crypto.randomUUID()}`
	const { dataPoints, usageEnv } = capturingUsageEnv()

	await recordUsage(usageEnv, {
		userId,
		eventType: 'dynamic_worker_invoke',
		durationMs: 42,
		outcome: 'success',
		timestamp: '2026-09-12T12:00:00.000Z',
		surface: 'execute',
		executeShape: 'glue',
		cacheReuse: 'hit',
		codeChars: 1280,
		paramsChars: 17,
	})

	expect(dataPoints).toEqual([
		dataPoint(
			userId,
			[
				'dynamic_worker_invoke',
				'',
				'success',
				'2026-09-12T12:00:00.000Z',
				'execute',
				'glue',
				'hit',
			],
			[42, 0, 0, 1280, 17],
		),
	])
	const [point] = dataPoints
	expect(point?.blobs?.[usageEventBlobIndexes.cacheReuse]).toBe('hit')
	expect(point?.doubles?.[usageEventDoubleIndexes.codeChars]).toBe(1280)
	expect(point?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBe(17)
})

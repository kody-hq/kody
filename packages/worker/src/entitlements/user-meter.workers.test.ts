import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { EntitlementLimitError } from './errors.ts'
import { planLimits } from '#universal/plans.ts'
import {
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	consumeExecuteUniqueWorkerDay,
	readDailyEntitlementResourceUsage,
	refundDailyEntitlement,
} from './service.ts'
import { ensureEntitlementTestSchema } from './test-schema.ts'
import { userMeterRpc } from './user-meter-client.ts'
import { UserMeter, userMeterMirrorUpdatedAtToken } from './user-meter-do.ts'
import { withPatchedDbPrepare } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

type DailyResource = Parameters<typeof consumeDailyEntitlement>[0]['resource']

async function seedFreeUser(emailPrefix: string) {
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `${emailPrefix}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `meter-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'free',
		stableUserId: userId,
	})
	const meter = userMeterRpc({ env, userId: ownerIdFromStored(userId) })
	const consume = async (resource: DailyResource, now: Date) => {
		const input = {
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(userId),
			email,
			now,
		}
		if (resource === 'execute_unique_workers_per_day') {
			await consumeExecuteUniqueWorkerDay({
				...input,
				workerId: `kody-${crypto.randomUUID()}`,
			})
			return
		}
		await consumeDailyEntitlement({ ...input, resource })
	}
	const readDaily = (resource: DailyResource, now: Date) =>
		meter.read({ resource, day: utcDayKey(now), now: now.toISOString() })
	return { email, userId, meter, consume, readDaily }
}

function meterStub(userId: string) {
	return env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(userId)),
		),
	)
}

function countDailyCounterPrepares() {
	const counter = { calls: 0 }
	const patch = withPatchedDbPrepare(
		env.APP_DB,
		(originalPrepare) =>
			((query: string) => {
				if (query.includes('entitlement_daily_counters')) counter.calls += 1
				return originalPrepare(query)
			}) as D1Database['prepare'],
	)
	return Object.assign(counter, {
		[Symbol.dispose]: () => patch[Symbol.dispose](),
	})
}

function catchError<T>(promise: Promise<T>) {
	return promise.then(
		(value) => value,
		(error: unknown) => error,
	)
}

function emptyExport(deletingAt: string | null = null) {
	return {
		counters: [],
		storageBytesState: null,
		deletionState: { deletingAt, activeWriteLeaseCount: 0, writeLeases: [] },
		inboundConnectionLastUsed: [],
		nextStartAfter: null,
		truncated: false,
	}
}

function sqliteNames(state: DurableObjectState, where: string) {
	return state.storage.sql
		.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE ${where}`)
		.toArray()
		.map((row) => row.name)
}

function expectSchemaV15(state: DurableObjectState) {
	const version = state.storage.sql
		.exec<{ value: number }>(
			`SELECT value FROM user_meter_meta WHERE key = 'schema_version' LIMIT 1`,
		)
		.toArray()[0]
	expect(Number(version?.value)).toBe(15)
	expect(
		state.storage.sql
			.exec<{ name: string }>(`PRAGMA table_info(account_write_leases)`)
			.toArray()
			.map((row) => String(row.name)),
	).toEqual(['token', 'holder', 'acquired_at', 'pending_repair_id'])
	expect(
		sqliteNames(
			state,
			`type = 'table' AND name IN ('dynamic_worker_days', 'execute_call_days', 'inbound_mcp_connection_last_used') ORDER BY name`,
		),
	).toEqual([
		'dynamic_worker_days',
		'execute_call_days',
		'inbound_mcp_connection_last_used',
	])
}

/**
 * A stable recent instant for daily-counter tests: yesterday at 15:00 UTC.
 * The UserMeter DO purges daily counters older than its retention window
 * (`userMeterDailyCounterRetentionDays`) against the real clock, so a
 * hardcoded date silently ages out and flips cold-consume reads back to
 * `needs_bootstrap`.
 */
function recentDailyCounterNow(): Date {
	const now = new Date()
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 15),
	)
}

test('fresh UserMeter schema is v15 and warm v7 upgrades to v15 preserving leases', async () => {
	const fresh = await seedFreeUser('meter-schema-v12-fresh')
	await runInDurableObject(
		meterStub(fresh.userId),
		async (instance: UserMeter, state) => {
			expect(instance).toBeInstanceOf(UserMeter)
			expectSchemaV15(state)
		},
	)

	const warm = await seedFreeUser('meter-schema-v7-upgrade')
	await runInDurableObject(
		meterStub(warm.userId),
		async (instance: UserMeter, state) => {
			await state.storage.deleteAll()
			state.storage.sql.exec(`
			CREATE TABLE user_meter_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			);
			INSERT INTO user_meter_meta (key, value)
			VALUES ('schema_version', 7);
			CREATE TABLE account_write_leases (
				token TEXT PRIMARY KEY NOT NULL,
				holder TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				pending_repair_id TEXT,
				authority TEXT NOT NULL DEFAULT 'legacy'
			);
			CREATE INDEX idx_account_write_leases_authority_acquired_token
			ON account_write_leases (authority, acquired_at, token);
			CREATE TABLE package_service_states (
				package_id TEXT NOT NULL,
				service_name TEXT NOT NULL,
				status TEXT NOT NULL,
				source_updated_at TEXT NOT NULL,
				PRIMARY KEY (package_id, service_name)
			);
			CREATE INDEX idx_package_service_states_status_source
			ON package_service_states (status, source_updated_at);
			INSERT INTO account_write_leases (
				token, holder, acquired_at, pending_repair_id, authority
			) VALUES (
				'warm-v7-token', 'warm-v7-holder',
				'2026-08-03T00:00:00.000Z', 'repair-v7', 'do'
			);
		`)

			const proto = Object.getPrototypeOf(instance) as {
				initializeSchema: () => void
			}
			proto.initializeSchema.call(instance)

			expectSchemaV15(state)
			expect(
				state.storage.sql
					.exec(
						`SELECT token, holder, acquired_at, pending_repair_id
					FROM account_write_leases`,
					)
					.toArray(),
			).toEqual([
				{
					token: 'warm-v7-token',
					holder: 'warm-v7-holder',
					acquired_at: '2026-08-03T00:00:00.000Z',
					pending_repair_id: 'repair-v7',
				},
			])
			expect(
				sqliteNames(
					state,
					`name IN (
						'idx_account_write_leases_authority_acquired_token',
						'package_service_states',
						'idx_package_service_states_status_source'
					)`,
				),
			).toEqual([])
		},
	)
}, 30_000)

test('UserMeter claimDynamicWorkerDay is first-seen per worker and day, and prunes stale claims', async () => {
	const user = await seedFreeUser('meter-dw-day-claim')
	const today = utcDayKey(new Date())
	const claim = (workerId: string, day = today) =>
		user.meter.claimDynamicWorkerDay({
			workerId,
			day,
			createdAt:
				day === today ? new Date().toISOString() : `${day}T00:00:00.000Z`,
		})

	expect(await claim('kody-worker-a')).toEqual({ created: true })
	expect(await claim('kody-worker-a')).toEqual({ created: false })
	expect(await claim('kody-worker-b')).toEqual({ created: true })

	const pruned = await seedFreeUser('meter-dw-day-prune')
	const stub = meterStub(pruned.userId)
	await stub.claimDynamicWorkerDay({
		workerId: 'kody-stale',
		day: '2020-01-01',
		createdAt: '2020-01-01T00:00:00.000Z',
	})
	await stub.claimDynamicWorkerDay({
		workerId: 'kody-fresh',
		day: today,
		createdAt: new Date().toISOString(),
	})
	await runInDurableObject(stub, async (_instance: UserMeter, state) => {
		expect(
			state.storage.sql
				.exec(
					`SELECT worker_id, day FROM dynamic_worker_days ORDER BY worker_id`,
				)
				.toArray(),
		).toEqual([{ worker_id: 'kody-fresh', day: today }])
	})
}, 30_000)

test('cold, warm, and next-UTC-day daily consumes start at zero without preparing D1 entitlement_daily_counters', async () => {
	const resource = 'email_sends_per_day'
	using prepares = countDailyCounterPrepares()

	const coldNow = recentDailyCounterNow()
	const cold = await seedFreeUser('meter-cold-zero')
	expect(await cold.meter.read({ resource, day: utcDayKey(coldNow) })).toEqual({
		outcome: 'needs_bootstrap',
	})
	await cold.consume(resource, coldNow)
	expect(await cold.readDaily(resource, coldNow)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})

	const warmNow = new Date()
	const warm = await seedFreeUser('meter-warm-no-d1')
	await warm.meter.initialize({
		resource,
		day: utcDayKey(warmNow),
		count: 0,
		updatedAt: warmNow.toISOString(),
	})
	await warm.consume(resource, warmNow)
	await expect(
		readDailyEntitlementResourceUsage({
			env,
			userId: ownerIdFromStored(warm.userId),
			resource,
			now: warmNow,
		}),
	).resolves.toBe(1)

	const dayOne = recentDailyCounterNow()
	// Ten hours later crosses into the next UTC day (15:00Z -> 01:00Z).
	const dayTwo = new Date(dayOne.getTime() + 10 * 60 * 60 * 1000)
	const nextDay = await seedFreeUser('meter-next-day')
	await nextDay.consume(resource, dayOne)
	expect(await nextDay.readDaily(resource, dayOne)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
	expect(await nextDay.readDaily(resource, dayTwo)).toEqual({
		outcome: 'needs_bootstrap',
	})
	await nextDay.consume(resource, dayTwo)
	expect(await nextDay.readDaily(resource, dayTwo)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
	expect(prepares.calls).toBe(0)
}, 30_000)

test('UserMeter consume denies public execute when the UTC week hits first', async () => {
	const monday = new Date('2026-07-06T15:00:00.000Z')
	const tuesday = new Date('2026-07-07T15:00:00.000Z')
	const wednesday = new Date('2026-07-08T15:00:00.000Z')
	const resource = 'execute_unique_workers_per_day'
	const user = await seedFreeUser('meter-weekly-execute')
	for (const [day, count] of [
		[monday, 150],
		[tuesday, 150],
		[wednesday, 99],
	] as const) {
		await user.meter.initialize({
			resource,
			day: utcDayKey(day),
			count,
			updatedAt: day.toISOString(),
		})
	}
	expect(
		await user.meter.readRange({
			resource,
			startDay: utcDayKey(monday),
			endDay: utcDayKey(wednesday),
			now: wednesday.toISOString(),
		}),
	).toEqual({ outcome: 'ready', count: 399 })

	const claim = (workerId: string) =>
		consumeExecuteUniqueWorkerDay({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(user.userId),
			email: user.email,
			workerId,
			now: wednesday,
		})
	await expect(claim('kody-week-a')).resolves.toEqual({
		created: true,
		used: 100,
		limit: 150,
		weekUsed: 400,
		weekLimit: 400,
	})
	const denied = await catchError(claim('kody-week-b'))
	expect(denied).toBeInstanceOf(EntitlementLimitError)
	expect(denied).toMatchObject({
		details: { resource, limit: 400, current: 400, window: 'week' },
	})
}, 30_000)

test('consumeExecuteUniqueWorkerDay spends one unit per new worker per day, repeats free, and leaves denied workers unclaimed', async () => {
	const now = recentDailyCounterNow()
	const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000)
	const user = await seedFreeUser('meter-execute-unique-workers')
	const limit = planLimits.free.maxExecuteUniqueWorkersPerDay
	const claim = (workerId: string, at = now) =>
		consumeExecuteUniqueWorkerDay({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(user.userId),
			email: user.email,
			workerId,
			now: at,
		})

	await expect(claim('kody-a')).resolves.toMatchObject({
		created: true,
		used: 1,
	})
	await expect(claim('kody-a')).resolves.toMatchObject({
		created: false,
		used: 1,
	})
	await runInDurableObject(
		meterStub(user.userId),
		async (_instance: UserMeter, state) => {
			state.storage.sql.exec(
				`UPDATE daily_counters SET count = ? WHERE resource = ? AND day = ?`,
				limit,
				'execute_unique_workers_per_day',
				utcDayKey(now),
			)
		},
	)
	await expect(claim('kody-a')).resolves.toMatchObject({
		created: false,
		used: limit,
	})
	const denied = await catchError(claim('kody-b'))
	expect(denied).toMatchObject({
		details: {
			resource: 'execute_unique_workers_per_day',
			limit,
			current: limit,
		},
	})
	await runInDurableObject(
		meterStub(user.userId),
		async (_instance: UserMeter, state) => {
			expect(
				state.storage.sql
					.exec(
						`SELECT worker_id FROM dynamic_worker_days WHERE day = ? ORDER BY worker_id`,
						utcDayKey(now),
					)
					.toArray(),
			).toEqual([{ worker_id: 'kody-a' }])
		},
	)
	await expect(claim('kody-b', nextDay)).resolves.toMatchObject({
		created: true,
		used: 1,
	})
}, 30_000)

test('UserMeter admitExecuteCall admits up to the per-minute limit, resets on the next minute, and refuses identical repeats', async () => {
	const user = await seedFreeUser('meter-execute-admission')
	const minuteStart = Date.parse('2026-10-10T12:00:00.000Z')
	const admit = (nowMs: number) =>
		user.meter.admitExecuteCall({ nowMs, limitPerMinute: 2 })
	await expect(admit(minuteStart + 1_000)).resolves.toEqual({
		admitted: true,
		count: 1,
	})
	await expect(admit(minuteStart + 2_000)).resolves.toEqual({
		admitted: true,
		count: 2,
	})
	await expect(admit(minuteStart + 45_000)).resolves.toEqual({
		admitted: false,
		reason: 'rate',
		count: 2,
		retryAfterMs: 15_000,
	})
	await expect(admit(minuteStart + 60_000)).resolves.toEqual({
		admitted: true,
		count: 1,
	})
	const repeat = { key: 'same-call', limit: 1, windowMs: 60_000 }
	await expect(
		user.meter.admitExecuteCall({
			nowMs: minuteStart + 61_000,
			limitPerMinute: 2,
			repeat,
		}),
	).resolves.toEqual({ admitted: true, count: 2 })
	await expect(
		user.meter.admitExecuteCall({
			nowMs: minuteStart + 62_000,
			limitPerMinute: 3,
			repeat,
		}),
	).resolves.toEqual({
		admitted: false,
		reason: 'repeat',
		repeats: 1,
		retryAfterMs: 59_000,
	})
	// Four admitted calls; the rate and repeat refusals are not counted.
	const trend = await user.meter.readDailyTrend({
		now: new Date(minuteStart + 62_000).toISOString(),
	})
	expect(trend.executeCalls).toEqual([{ day: '2026-10-10', count: 4 }])
}, 30_000)

test('UserMeter readUsageSnapshot returns daily, weekly, and storage in one call', async () => {
	const monday = new Date('2026-07-06T15:00:00.000Z')
	const tuesday = new Date('2026-07-07T15:00:00.000Z')
	const user = await seedFreeUser('meter-usage-snapshot')
	await user.meter.initialize({
		resource: 'execute_unique_workers_per_day',
		day: utcDayKey(monday),
		count: 10,
		updatedAt: monday.toISOString(),
	})
	await user.meter.initialize({
		resource: 'execute_unique_workers_per_day',
		day: utcDayKey(tuesday),
		count: 7,
		updatedAt: tuesday.toISOString(),
	})
	await user.meter.initialize({
		resource: 'email_sends_per_day',
		day: utcDayKey(tuesday),
		count: 3,
		updatedAt: tuesday.toISOString(),
	})
	await user.meter.initializeStorageBytes({
		bytes: 42,
		updatedAt: tuesday.toISOString(),
	})

	const snapshot = await user.meter.readUsageSnapshot({
		day: utcDayKey(tuesday),
		weekStart: utcDayKey(monday),
		dailyResources: ['execute_unique_workers_per_day', 'email_sends_per_day'],
		weeklyResources: ['execute_unique_workers_per_day'],
		includeStorageBytes: true,
		now: tuesday.toISOString(),
	})
	expect(snapshot.daily).toEqual([
		expect.objectContaining({
			resource: 'execute_unique_workers_per_day',
			outcome: 'ready',
			count: 7,
		}),
		expect.objectContaining({
			resource: 'email_sends_per_day',
			outcome: 'ready',
			count: 3,
		}),
	])
	expect(snapshot.weekly).toEqual([
		{
			resource: 'execute_unique_workers_per_day',
			outcome: 'ready',
			count: 17,
		},
	])
	expect(snapshot.storageBytes).toMatchObject({
		outcome: 'ready',
		bytes: 42,
	})

	const cold = await user.meter.readUsageSnapshot({
		day: utcDayKey(tuesday),
		weekStart: utcDayKey(monday),
		dailyResources: ['outbound_fetches_per_day'],
		weeklyResources: ['outbound_fetches_per_day'],
		includeStorageBytes: false,
		now: tuesday.toISOString(),
	})
	expect(cold.daily).toEqual([
		{ resource: 'outbound_fetches_per_day', outcome: 'needs_bootstrap' },
	])
	expect(cold.weekly).toEqual([
		{
			resource: 'outbound_fetches_per_day',
			outcome: 'ready',
			count: 0,
		},
	])
	expect(cold.storageBytes).toBeNull()
}, 30_000)

test('UserMeter readDailyTrend returns counters and unique worker days for the retention window', async () => {
	const now = new Date('2026-10-07T15:00:00.000Z')
	const yesterday = new Date('2026-10-06T15:00:00.000Z')
	const user = await seedFreeUser('meter-daily-trend')
	await user.meter.initialize({
		resource: 'execute_unique_workers_per_day',
		day: utcDayKey(yesterday),
		count: 11,
		updatedAt: yesterday.toISOString(),
	})
	await user.meter.initialize({
		resource: 'job_runs_per_day',
		day: utcDayKey(yesterday),
		count: 2,
		updatedAt: yesterday.toISOString(),
	})
	await user.meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: utcDayKey(yesterday),
		createdAt: yesterday.toISOString(),
	})
	await user.meter.claimDynamicWorkerDay({
		workerId: 'worker-b',
		day: utcDayKey(yesterday),
		createdAt: yesterday.toISOString(),
	})
	await user.meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: utcDayKey(now),
		createdAt: now.toISOString(),
	})

	for (const nowMs of [yesterday.getTime(), now.getTime(), now.getTime()]) {
		await user.meter.admitExecuteCall({ nowMs, limitPerMinute: 300 })
	}

	const trend = await user.meter.readDailyTrend({ now: now.toISOString() })
	expect(trend.retentionDays).toBeGreaterThan(0)
	expect(trend.endDay).toBe(utcDayKey(now))
	expect(trend.counters).toEqual(
		expect.arrayContaining([
			{
				resource: 'execute_unique_workers_per_day',
				day: utcDayKey(yesterday),
				count: 11,
			},
			{
				resource: 'job_runs_per_day',
				day: utcDayKey(yesterday),
				count: 2,
			},
		]),
	)
	expect(trend.uniqueWorkerDays).toEqual([
		{ day: utcDayKey(yesterday), count: 2 },
		{ day: utcDayKey(now), count: 1 },
	])
	expect(trend.executeCalls).toEqual([
		{ day: utcDayKey(yesterday), count: 1 },
		{ day: utcDayKey(now), count: 2 },
	])
}, 30_000)

test('UserMeter daily entitlement consume/refund/read/export/purge workflow is per-user without D1 daily table', async () => {
	const now = recentDailyCounterNow()
	const day = utcDayKey(now)
	const resource = 'email_sends_per_day'
	const sendLimit = planLimits.free.maxEmailSendsPerDay
	const userA = await seedFreeUser('meter-a')
	const userB = await seedFreeUser('meter-b')
	const readA = () => userA.readDaily(resource, now)
	const refundA = () =>
		refundDailyEntitlement({
			env,
			userId: ownerIdFromStored(userA.userId),
			resource,
			now,
		})

	expect(userMeterDurableObjectName(ownerIdFromStored(userA.userId))).toBe(
		userA.userId,
	)
	using prepares = countDailyCounterPrepares()

	await userA.consume(resource, now)
	expect(await readA()).toMatchObject({ outcome: 'ready', count: 1 })
	for (let index = 1; index < sendLimit; index += 1) {
		await userA.consume(resource, now)
	}
	const concurrent = await Promise.all(
		Array.from({ length: 8 }, () =>
			userA.consume(resource, now).then(
				() => null,
				(thrown: unknown) => thrown,
			),
		),
	)
	expect(
		concurrent.filter((result) => result instanceof EntitlementLimitError),
	).toHaveLength(8)

	await userB.consume(resource, now)
	expect(await userB.readDaily(resource, now)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
	expect(await readA()).toMatchObject({ outcome: 'ready', count: sendLimit })

	await refundA()
	expect(await readA()).toMatchObject({
		outcome: 'ready',
		count: sendLimit - 1,
	})
	for (let index = 0; index < sendLimit; index += 1) await refundA()
	expect(await readA()).toMatchObject({ outcome: 'ready', count: 0 })

	await userA.consume(resource, now)
	await userA.consume('execute_unique_workers_per_day', now)
	expect((await userA.meter.exportCounters({})).counters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ resource, day, count: 1 }),
			expect.objectContaining({
				resource: 'execute_unique_workers_per_day',
				day,
				count: 1,
			}),
		]),
	)

	const [purgeResult, readDuringPurge, exportDuringPurge] = await Promise.all([
		userA.meter.purge(),
		catchError(userA.meter.read({ resource, day })),
		catchError(userA.meter.exportCounters({})),
	])
	expect(purgeResult).toEqual({ ok: true })
	expect(readDuringPurge).not.toBeInstanceOf(Error)
	expect(exportDuringPurge).not.toBeInstanceOf(Error)
	expect(await userA.meter.read({ resource, day })).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await userA.meter.exportCounters({})).toEqual(emptyExport())
	expect(await userB.readDaily(resource, now)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})

	await expect(userA.consume(resource, now)).resolves.toBeUndefined()
	expect(await readA()).toMatchObject({ outcome: 'ready', count: 1 })
	expect(prepares.calls).toBe(0)

	await runInDurableObject(
		meterStub(userA.userId),
		async (instance: UserMeter) => {
			await expect(
				instance.consume({
					resource,
					day: 'not-a-day',
					limit: 1,
					updatedAt: '2026-07-31T15:00:00.000Z',
				}),
			).rejects.toThrow(/UTC YYYY-MM-DD/)
		},
	)
}, 30_000)

test('UserMeter purge blocks concurrent RPCs across deleteAll and schema restore', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const user = await seedFreeUser('meter-purge-concurrency')
	await user.meter.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 4,
		updatedAt: now.toISOString(),
	})

	let releaseDelete: (() => void) | undefined
	const deletePaused = new Promise<void>((resolve) => {
		releaseDelete = resolve
	})
	let deleteAllReached = false
	await runInDurableObject(
		meterStub(user.userId),
		async (instance: UserMeter, state) => {
			expect(instance).toBeInstanceOf(UserMeter)
			const originalDeleteAll = state.storage.deleteAll.bind(state.storage)
			state.storage.deleteAll = async () => {
				await originalDeleteAll()
				deleteAllReached = true
				await deletePaused
			}
		},
	)

	const purgePromise = user.meter.purge()
	await vi
		.waitFor(() => expect(deleteAllReached).toBe(true), {
			timeout: 5_000,
			interval: 1,
		})
		.catch(() => {
			throw new Error('Timed out waiting for purge deleteAll.')
		})
	const readPromise = catchError(
		user.meter.read({ resource: 'email_sends_per_day', day }),
	)
	const exportPromise = catchError(user.meter.exportCounters({}))
	// Give queued RPCs a chance to enter the wiped-schema window if
	// blockConcurrencyWhile is missing around deleteAll+initializeSchema.
	await new Promise((resolve) => setTimeout(resolve, 25))
	releaseDelete!()

	expect(await purgePromise).toEqual({ ok: true })
	expect(await readPromise).toEqual({ outcome: 'needs_bootstrap' })
	expect(await exportPromise).toEqual(emptyExport())
	expect(
		await user.meter.read({ resource: 'email_sends_per_day', day }),
	).toEqual({ outcome: 'needs_bootstrap' })
}, 30_000)

test('storage bytes are UserMeter-authoritative: cold zero bootstrap, denial, concurrency, and missing-user semantics', async () => {
	const storageLimit = planLimits.free.maxStorageBytes
	const reserve = (
		user: { userId: string; email: string | null },
		requested: number,
	) =>
		assertWithinStorageBytesEntitlement({
			db: env.APP_DB,
			env,
			userId: ownerIdFromStored(user.userId),
			email: user.email,
			requested,
		})

	// Cold bootstrap seeds from physical (0 here), then reserves 5.
	const user = await seedFreeUser('meter-storage-do-authority')
	await reserve(user, 5)
	expect(await user.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 5,
	})
	// 5 + (limit - 4) = limit + 1 > limit.
	const denied = await catchError(reserve(user, storageLimit - 4))
	expect(denied).toBeInstanceOf(EntitlementLimitError)
	expect(denied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: 5,
		},
	})

	// Concurrent reservations are atomic in UserMeter.
	const concurrentUser = await seedFreeUser('meter-storage-concurrent-do')
	await concurrentUser.meter.initializeStorageBytes({
		bytes: storageLimit - 10,
		updatedAt: '2026-07-31T15:00:00.000Z',
	})
	const attempts = await Promise.all(
		Array.from({ length: 20 }, () =>
			reserve(concurrentUser, 5).then(
				() => 'reserved' as const,
				(error: unknown) => error,
			),
		),
	)
	expect(attempts.filter((result) => result === 'reserved')).toHaveLength(2)
	expect(
		attempts.filter((result) => result instanceof EntitlementLimitError),
	).toHaveLength(18)
	expect(await concurrentUser.meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: storageLimit,
	})

	// Missing user (synthetic context) gets free-plan semantics.
	const missing = { userId: ownerIdFromStored('a').repeat(64), email: null }
	await expect(reserve(missing, 1)).resolves.toBeUndefined()
	const missingDenied = await catchError(reserve(missing, storageLimit + 1))
	expect(missingDenied).toBeInstanceOf(EntitlementLimitError)
	expect(missingDenied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: 0,
		},
	})
}, 30_000)

test('UserMeter storage RPCs, authoritative export state, and purge work additively', async () => {
	const { meter } = await seedFreeUser('meter-storage-export-purge')
	await meter.initializeStorageBytes({
		bytes: 42,
		updatedAt: '2026-07-31T17:00:00.000Z',
	})
	await meter.reserveStorageBytes({
		requested: 8,
		limit: 1_000,
		updatedAt: '2026-07-31T17:01:00.000Z',
	})
	await meter.setStorageBytes({
		bytes: 11,
		updatedAt: '2026-07-31T17:02:00.000Z',
	})

	// Wall-clock retention on export/read; keep counters inside the 14-day window.
	const day = utcDayKey()
	const counterUpdatedAt = new Date().toISOString()
	for (const resource of [
		'email_receives_per_day',
		'email_sends_per_day',
		'execute_unique_workers_per_day',
		'job_runs_per_day',
		'automation_invocations_per_day',
		'outbound_fetches_per_day',
	] as const) {
		await meter.initialize({
			resource,
			day,
			count: 1,
			updatedAt: counterUpdatedAt,
		})
	}

	const firstPage = await meter.exportCounters({ pageSize: 2 })
	expect(firstPage).toMatchObject({
		truncated: true,
		nextStartAfter: expect.any(String),
		storageBytesState: {
			bytes: 11,
			revision: 3,
			updatedAt: '2026-07-31T17:02:00.000Z',
			mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(3),
		},
		deletionState: {
			deletingAt: null,
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		inboundConnectionLastUsed: [],
	})
	expect(firstPage.counters).toHaveLength(2)

	const secondPage = await meter.exportCounters({
		pageSize: 2,
		startAfter: firstPage.nextStartAfter,
	})
	expect(secondPage).toMatchObject({
		truncated: true,
		nextStartAfter: expect.any(String),
		storageBytesState: null,
		deletionState: null,
		inboundConnectionLastUsed: null,
	})
	expect(secondPage.counters).toHaveLength(2)

	const thirdPage = await meter.exportCounters({
		pageSize: 2,
		startAfter: secondPage.nextStartAfter,
	})
	expect(thirdPage).toMatchObject({ truncated: false, nextStartAfter: null })
	expect(thirdPage.counters).toHaveLength(2)

	await expect(meter.purge()).resolves.toEqual({ ok: true })
	expect(await meter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meter.exportCounters({})).toEqual(emptyExport())
}, 30_000)

test('UserMeter deletion leases: mark, acquire, release, repair, export, and purge tombstone', async () => {
	const { meter: meterA } = await seedFreeUser('meter-deletion-a')
	const { meter: meterB } = await seedFreeUser('meter-deletion-b')
	const tokenA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	const tokenB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
	const acquire = (
		meter: typeof meterA,
		token: string,
		holder: string,
		acquiredAt: string,
	) => meter.acquireWriteLease({ token, holder, acquiredAt })

	// markDeleting preserves tombstone; repeated calls return the first timestamp.
	expect(
		await meterA.markDeleting({ deletingAt: '2026-08-01 10:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: true,
		leaseCount: 0,
	})
	expect(
		await meterA.markDeleting({ deletingAt: '2026-08-01 11:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: false,
		leaseCount: 0,
	})
	expect(await meterA.clearDeleting()).toEqual({ cleared: true })
	expect(await meterA.readDeletionState()).toEqual({ deletingAt: null })
	expect(await meterA.clearDeleting()).toEqual({ cleared: false })
	expect(
		(await meterA.markDeleting({ deletingAt: '2026-08-01 12:00:00' })).created,
	).toBe(true)
	expect(
		await meterA.clearDeleting({ expectedDeletingAt: '2026-08-01 10:00:00' }),
	).toEqual({ cleared: false })
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-01 12:00:00',
	})
	expect(
		await meterA.clearDeleting({ expectedDeletingAt: '2026-08-01 12:00:00' }),
	).toEqual({ cleared: true })
	expect(
		await meterA.markDeleting({ deletingAt: '2026-08-01 10:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: true,
		leaseCount: 0,
	})

	// acquireWriteLease is idempotent (same token).
	for (const [token, holder, acquiredAt] of [
		[tokenA, 'test:writer-1', '2026-08-01 10:05:00'],
		[tokenA, 'test:writer-1', '2026-08-01 10:05:00'],
		[tokenB, 'test:writer-2', '2026-08-01 10:06:00'],
	] as const) {
		await expect(acquire(meterB, token, holder, acquiredAt)).resolves.toEqual({
			acquired: true,
		})
	}
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 2 })
	expect(
		await meterB.markDeleting({ deletingAt: '2026-08-01 09:00:00' }),
	).toEqual({
		deletingAt: '2026-08-01 09:00:00',
		created: true,
		leaseCount: 2,
	})
	await expect(
		acquire(
			meterB,
			'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
			'test:blocked-during-deletion',
			'2026-08-01 10:06:30',
		),
	).resolves.toEqual({ acquired: false })
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 2 })

	// listWriteLeases is paged and returns entries without authority field.
	const listed = await meterB.listWriteLeases({ pageSize: 1 })
	expect(listed.leases).toHaveLength(1)
	expect(listed.truncated).toBe(true)
	expect(listed.leases[0]).toEqual(expect.objectContaining({ token: tokenA }))
	const listedRest = await meterB.listWriteLeases({
		pageSize: 10,
		startAfter: listed.nextStartAfter,
	})
	expect(listedRest.leases).toHaveLength(1)
	expect(listedRest.truncated).toBe(false)
	expect(listedRest.leases[0]).toEqual(
		expect.objectContaining({ token: tokenB }),
	)

	await expect(meterB.releaseWriteLease({ token: tokenA })).resolves.toEqual({
		released: true,
	})
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 1 })
	// A reset retry of the same release still proves the lease was held, while
	// a token that was never acquired does not.
	await expect(meterB.releaseWriteLease({ token: tokenA })).resolves.toEqual({
		released: true,
	})
	await expect(
		meterB.releaseWriteLease({ token: 'lease_never_acquired_token' }),
	).resolves.toEqual({ released: false })

	// Acquiring on a deleted account is blocked.
	await expect(
		acquire(
			meterA,
			'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			'test:blocked',
			'2026-08-01 10:07:00',
		),
	).resolves.toEqual({ acquired: false })

	// Repair: prepare + finalize (idempotent).
	const repairInput = {
		token: tokenB,
		expectedAcquiredAt: '2026-08-01 10:06:00',
	}
	const prepared = await meterB.prepareWriteLeaseRepair(repairInput)
	expect(prepared).toEqual(
		expect.objectContaining({
			prepared: true,
			token: tokenB,
			acquiredAt: '2026-08-01 10:06:00',
		}),
	)
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'
	await expect(meterB.prepareWriteLeaseRepair(repairInput)).resolves.toEqual(
		expect.objectContaining({ prepared: true, repairId }),
	)
	await expect(meterB.assertWriteLeaseHeld({ token: tokenB })).resolves.toEqual(
		{ held: true },
	)
	await expect(
		meterB.finalizeWriteLeaseRepair({ ...repairInput, repairId }),
	).resolves.toEqual({ finalized: true })
	await expect(meterB.assertWriteLeaseHeld({ token: tokenB })).resolves.toEqual(
		{ held: false },
	)
	// Idempotent finalize: already gone, returns finalized: true.
	await expect(
		meterB.finalizeWriteLeaseRepair({ ...repairInput, repairId }),
	).resolves.toEqual({ finalized: true })

	// Export: deletionState emitted on first page only.
	const day = utcDayKey()
	const counterUpdatedAt = new Date().toISOString()
	for (const resource of [
		'email_receives_per_day',
		'email_sends_per_day',
	] as const) {
		await meterA.initialize({
			resource,
			day,
			count: 1,
			updatedAt: counterUpdatedAt,
		})
	}
	const firstPage = await meterA.exportCounters({ pageSize: 1 })
	expect(firstPage).toMatchObject({
		truncated: true,
		deletionState: {
			deletingAt: '2026-08-01 10:00:00',
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		inboundConnectionLastUsed: [],
	})
	expect(
		await meterA.exportCounters({
			pageSize: 1,
			startAfter: firstPage.nextStartAfter,
		}),
	).toMatchObject({ deletionState: null, inboundConnectionLastUsed: null })

	// Purge resets counters but preserves the deletion tombstone.
	await expect(meterA.purge()).resolves.toEqual({ ok: true })
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-01 10:00:00',
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(await meterA.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meterA.exportCounters({})).toEqual(
		emptyExport('2026-08-01 10:00:00'),
	)
	await expect(
		acquire(
			meterA,
			'ffffffff-ffff-4fff-8fff-ffffffffffff',
			'test:post-purge',
			'2026-08-01 13:00:00',
		),
	).resolves.toEqual({ acquired: false })

	expect(await meterB.readDeletionState()).toEqual({
		deletingAt: '2026-08-01 09:00:00',
	})
	await expect(
		meterB.markDeleting({ deletingAt: '2026-08-01 15:00:00' }),
	).resolves.toEqual({
		deletingAt: '2026-08-01 09:00:00',
		created: false,
		leaseCount: 0,
	})
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 0 })
}, 30_000)

test('UserMeter inbound MCP last-used touches debounce, list, forget, export, and purge', async () => {
	const { meter } = await seedFreeUser('meter-inbound-last-used')
	const { meter: otherMeter } = await seedFreeUser(
		'meter-inbound-last-used-other',
	)
	const clientId = 'https://cursor.com/oauth/vG4-last-used/client.json'
	const firstUsedAt = '2026-03-20T12:00:00.000Z'
	const withinWindow = '2026-03-20T12:04:59.000Z'
	const afterWindow = '2026-03-20T12:05:01.000Z'
	const touch = (lastUsedAt: string) =>
		meter.touchInboundConnectionLastUsed({ clientId, lastUsedAt })
	const otherEntries = [{ clientId: 'other-client', lastUsedAt: afterWindow }]

	await expect(touch(firstUsedAt)).resolves.toEqual({ updated: true })
	await expect(touch(withinWindow)).resolves.toEqual({ updated: false })
	expect(await meter.listInboundConnectionLastUsed()).toEqual([
		{ clientId, lastUsedAt: firstUsedAt },
	])
	await expect(touch(afterWindow)).resolves.toEqual({ updated: true })
	expect(await meter.listInboundConnectionLastUsed()).toEqual([
		{ clientId, lastUsedAt: afterWindow },
	])
	await expect(
		otherMeter.touchInboundConnectionLastUsed(otherEntries[0]!),
	).resolves.toEqual({ updated: true })
	expect(await otherMeter.listInboundConnectionLastUsed()).toEqual(otherEntries)

	const day = utcDayKey()
	for (const resource of [
		'email_sends_per_day',
		'email_receives_per_day',
	] as const) {
		await meter.initialize({ resource, day, count: 1, updatedAt: afterWindow })
	}
	const firstPage = await meter.exportCounters({ pageSize: 1 })
	expect(firstPage.truncated).toBe(true)
	expect(firstPage.inboundConnectionLastUsed).toEqual([
		{ clientId, lastUsedAt: afterWindow },
	])
	expect(
		(
			await meter.exportCounters({
				pageSize: 1,
				startAfter: firstPage.nextStartAfter,
			})
		).inboundConnectionLastUsed,
	).toBeNull()

	await expect(
		meter.forgetInboundConnectionLastUsed({ clientId }),
	).resolves.toEqual({ ok: true })
	expect(await meter.listInboundConnectionLastUsed()).toEqual([])
	expect(await otherMeter.listInboundConnectionLastUsed()).toEqual(otherEntries)

	await expect(touch(afterWindow)).resolves.toEqual({ updated: true })
	await expect(meter.purge()).resolves.toEqual({ ok: true })
	expect(await meter.listInboundConnectionLastUsed()).toEqual([])
	expect(await meter.exportCounters({})).toEqual(emptyExport())
	expect(await otherMeter.listInboundConnectionLastUsed()).toEqual(otherEntries)
}, 30_000)

test('UserMeter budget spend resets on UTC month rollover', async () => {
	const { userId, meter } = await seedFreeUser('budget-meter')
	const month = '2026-02'
	const nextMonth = '2026-03'
	await meter.assertWithinBudgetAndRecord({
		month,
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 1_000_000,
		userBudgetMicroUsd: null,
		automationBudgetMicroUsd: null,
	})
	await meter.assertWithinBudgetAndRecord({
		month,
		actorUserId: null,
		automationSource: 'webhook',
		deltaMicroUsd: 2_000_000,
		userBudgetMicroUsd: null,
		automationBudgetMicroUsd: null,
	})
	expect(await meter.getBudgetSpend({ month })).toEqual({
		month,
		users: { [userId]: 1_000_000 },
		automationMicroUsd: 2_000_000,
	})
	expect(await meter.getBudgetSpend({ month: nextMonth })).toEqual({
		month: nextMonth,
		users: {},
		automationMicroUsd: 0,
	})
})

test('UserMeter budget enforcement separates user and automation limits', async () => {
	const { userId, meter } = await seedFreeUser('budget-enforce')
	const month = utcMonthKey(new Date())
	await expect(
		meter.assertWithinBudgetAndRecord({
			month,
			actorUserId: userId,
			automationSource: null,
			deltaMicroUsd: 0,
			userBudgetMicroUsd: 1_000_000,
			automationBudgetMicroUsd: null,
			actorUsername: 'member',
			orgSlug: 'team',
		}),
	).resolves.toBeDefined()
	await meter.assertWithinBudgetAndRecord({
		month,
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 1_000_000,
		userBudgetMicroUsd: 1_000_000,
		automationBudgetMicroUsd: null,
		actorUsername: 'member',
		orgSlug: 'team',
	})
	const atUserBudget = await catchError(
		meter.assertWithinBudgetAndRecord({
			month,
			actorUserId: userId,
			automationSource: null,
			deltaMicroUsd: 0,
			userBudgetMicroUsd: 1_000_000,
			automationBudgetMicroUsd: null,
			actorUsername: 'member',
			orgSlug: 'team',
		}),
	)
	expect(atUserBudget).toMatchObject({ name: 'BudgetLimitError' })

	await meter.assertWithinBudgetAndRecord({
		month,
		actorUserId: null,
		automationSource: 'schedule',
		deltaMicroUsd: 500_000,
		userBudgetMicroUsd: null,
		automationBudgetMicroUsd: 500_000,
		orgSlug: 'team',
	})
	const overAutomation = await catchError(
		meter.assertWithinBudgetAndRecord({
			month,
			actorUserId: null,
			automationSource: 'schedule',
			deltaMicroUsd: 1,
			userBudgetMicroUsd: null,
			automationBudgetMicroUsd: 500_000,
			orgSlug: 'team',
		}),
	)
	expect(overAutomation).toMatchObject({ name: 'BudgetLimitError' })
})

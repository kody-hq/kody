import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	registerStorageBucket,
} from '#worker/storage-buckets/service.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { withPatchedDbPrepare } from '#worker/test-support/user-meter.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { createMeteredDurableObjectStub } from '#worker/usage/durable-object-usage.ts'
import { storageRunnerDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	assertStorageRunnerWriteWithinEntitlement,
	createStorageKodyTools,
	createExecuteStorageId,
	emptyStorageRunnerEstimatedBytes,
	readOnlyStorageSqlDeniedMessage,
	StorageRunner,
	storageRunnerRpc,
	storageValueNotCloneableMessage,
} from './storage-runner.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

async function ensureStorageRunnerTestSchema() {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
}

function proStorageLimit() {
	const limit = planLimits.pro.maxStorageBytes
	if (limit === null) throw new Error('Expected a numeric pro storage cap.')
	return limit
}

async function seedPlannedStorageUser(
	prefix: string,
	plan: 'pro' | 'max',
	meterBytes: number,
) {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const username = `storage-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			userId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan,
	})
	// UserMeter is the storage-bytes authority; seed it directly.
	await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).initializeStorageBytes({
		bytes: meterBytes,
		updatedAt: new Date().toISOString(),
	})
	return { email, userId: ownerIdFromStored(userId) }
}

function setMeterBytes(userId: string, bytes: number) {
	return userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).setStorageBytes({
		bytes,
		updatedAt: new Date().toISOString(),
	})
}

const storageRunnerNamespace =
	env.STORAGE_RUNNER as DurableObjectNamespace<StorageRunner>

function runnerFor(userId: string, storageId = createExecuteStorageId()) {
	return storageRunnerRpc({
		env,
		userId: ownerIdFromStored(userId),
		storageId,
	})
}

function storageRunnerStub(userId: string, storageId: string) {
	return storageRunnerNamespace.get(
		storageRunnerNamespace.idFromName(JSON.stringify([userId, storageId])),
	)
}

function writableStorageTools(
	input: Parameters<typeof createStorageKodyTools>[0],
) {
	const tools = createStorageKodyTools(input)
	const { storageSet, storageDelete } = tools
	if (!storageSet || !storageDelete) {
		throw new Error('Expected writable storage tools.')
	}
	return { ...tools, storageSet, storageDelete }
}

async function entitlementRejection(promise: Promise<unknown>) {
	const thrown = await promise.then(
		() => null,
		(error: unknown) => error,
	)
	if (!(thrown instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	return thrown
}

async function bucketIds(userId: string) {
	await flushStorageBucketRegistrationsForTests()
	return listUserStorageBucketIds({ env, userId: ownerIdFromStored(userId) })
}

test('storage runner preserves isolated state per storage id', async () => {
	await ensureStorageRunnerTestSchema()
	const runners = [
		[runnerFor('user-123'), 2],
		[runnerFor('user-123'), 1],
	] as const

	for (const [runner, value] of runners) {
		await expect(runner.setValue({ key: 'counter', value })).resolves.toEqual({
			ok: true,
			key: 'counter',
		})
	}
	for (const [runner, value] of runners) {
		await expect(runner.getValue({ key: 'counter' })).resolves.toEqual({
			key: 'counter',
			value,
		})
		await expect(runner.exportStorage({ pageSize: 10 })).resolves.toMatchObject(
			{ entries: [{ key: 'counter', value }] },
		)
	}
})

test('storage runner exportStorage with maxBytes pages large values in bounded chunks', async () => {
	await ensureStorageRunnerTestSchema()
	const runner = runnerFor('user-export-bytes')
	const big = 'x'.repeat(1_000)
	for (const key of ['a', 'b', 'c', 'd', 'e']) {
		await runner.setValue({ key, value: big })
	}
	const seen: Array<string> = []
	let startAfter: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const result = await runner.exportStorage({
			pageSize: 250,
			startAfter,
			maxBytes: 2_000,
		})
		expect(result.entries.length).toBeLessThanOrEqual(2)
		seen.push(...result.entries.map((entry) => entry.key))
		if (!result.truncated) break
		startAfter = result.nextStartAfter
	}
	expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
	const unbounded = await runner.exportStorage({ pageSize: 250 })
	expect(unbounded.entries.map((entry) => entry.key)).toEqual(seen)
	expect(unbounded.truncated).toBe(false)
})

test('storage runner write tools enforce storage byte entitlements for planned users', async () => {
	const limit = proStorageLimit()
	const pro = await seedPlannedStorageUser('storage-planned', 'pro', limit)
	const proStorageId = createExecuteStorageId()
	const proTools = writableStorageTools({
		env,
		...pro,
		storageId: proStorageId,
		writable: true,
	})

	const denied = await entitlementRejection(
		proTools.storageSet({ key: 'new-key', value: 'new-value' }),
	)
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'pro',
		limit,
	})
	expect(denied.details.current).toBeGreaterThanOrEqual(limit)
	await expect(
		runnerFor(pro.userId, proStorageId).getValue({ key: 'new-key' }),
	).resolves.toEqual({ key: 'new-key', value: null })

	const max = await seedPlannedStorageUser('storage-max', 'max', limit)
	const maxTools = writableStorageTools({
		env,
		...max,
		storageId: createExecuteStorageId(),
		writable: true,
	})
	await expect(
		maxTools.storageSet({ key: 'new-key', value: 'new-value' }),
	).resolves.toEqual({ ok: true, key: 'new-key' })
})

test('storage runner storage byte entitlement aggregates only inventoried user buckets', async () => {
	const limit = proStorageLimit()
	const { email, userId } = await seedPlannedStorageUser(
		'storage-aggregate',
		'pro',
		0,
	)
	const storageIdA = createExecuteStorageId()
	const storageIdB = createExecuteStorageId()
	const runnerA = runnerFor(userId, storageIdA)
	const runnerB = runnerFor(userId, storageIdB)
	await runnerA.setValue({ key: 'first-bucket', value: 'stored bytes' })
	await runnerB.setValue({ key: 'second-bucket', value: 'stored bytes' })
	await expect(bucketIds(userId)).resolves.toEqual(
		[storageIdA, storageIdB].sort(),
	)

	const estimateA = (await runnerA.getEstimatedBytes()).estimatedBytes
	const estimateB = (await runnerB.getEstimatedBytes()).estimatedBytes
	expect(estimateA).toBeGreaterThan(0)
	expect(estimateB).toBeGreaterThan(0)
	await expect(
		userMeterRpc({ env, userId }).readStorageBytes(),
	).resolves.toMatchObject({ outcome: 'ready', bytes: 0 })
	const targetD1Bytes = limit - estimateB - 1
	// UserMeter holds the D1-payload byte counter composed with bucket
	// estimates by the baseline read.
	await setMeterBytes(userId, targetD1Bytes)
	const assertWrite = () =>
		assertStorageRunnerWriteWithinEntitlement({
			env,
			userId,
			email,
			storageId: storageIdB,
			requested: 1,
		})

	const aggregateDenied = await entitlementRejection(assertWrite())
	expect(aggregateDenied.details).toMatchObject({
		resource: 'storage_bytes',
		limit,
		current: targetD1Bytes + estimateA + estimateB,
	})

	// The first bucket still exists physically, but removing its ownership row
	// makes it ineligible for this user's aggregate. The remaining single bucket
	// is exactly at the allowed boundary and retains the previous behavior.
	await env.APP_DB.prepare(
		`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?`,
	)
		.bind(userId, storageIdA)
		.run()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
		storageIdB,
	])
	await expect(assertWrite()).resolves.toBeUndefined()
	await expect(runnerA.getValue({ key: 'first-bucket' })).resolves.toEqual({
		key: 'first-bucket',
		value: 'stored bytes',
	})
})

test('storage byte entitlement composes repo-session workspace estimates', async () => {
	const limit = proStorageLimit()
	const { email, userId } = await seedPlannedStorageUser(
		'storage-session',
		'pro',
		0,
	)
	const storageId = createExecuteStorageId()
	const runner = runnerFor(userId, storageId)
	await runner.setValue({ key: 'runner-data', value: 'stored bytes' })
	const sessionId = crypto.randomUUID()
	const sessionStorageId = `repo-session:${sessionId}`
	const pending: Array<Promise<unknown>> = []
	registerStorageBucket({
		env,
		userId,
		storageId: sessionStorageId,
		kind: 'repo_session',
		waitUntil: (promise) => pending.push(promise),
	})
	await Promise.all(pending)
	await flushStorageBucketRegistrationsForTests()

	const runnerBytes = (await runner.getEstimatedBytes()).estimatedBytes
	const sessionBytes = (
		await repoSessionRpc(env, sessionId).getEstimatedBytes()
	).estimatedBytes
	expect(sessionBytes).toBeGreaterThan(0)
	const d1Bytes = limit - runnerBytes - sessionBytes
	await setMeterBytes(userId, d1Bytes)
	const assertWrite = () =>
		assertStorageRunnerWriteWithinEntitlement({
			env,
			userId,
			email,
			storageId,
			requested: 1,
		})

	const denied = await entitlementRejection(assertWrite())
	expect(denied.details.current).toBe(d1Bytes + runnerBytes + sessionBytes)

	await env.APP_DB.prepare(
		`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?`,
	)
		.bind(userId, sessionStorageId)
		.run()
	await expect(assertWrite()).resolves.toBeUndefined()
})

test('storage runner supports raw SQL with explicit writable access', async () => {
	await ensureStorageRunnerTestSchema()
	const storageId = createExecuteStorageId()
	const runner = runnerFor('user-123', storageId)

	await expect(
		runner.sqlQuery({
			query:
				'create table if not exists counters (id integer primary key, value integer)',
			writable: true,
		}),
	).resolves.toMatchObject({ rowsWritten: 2 })
	await expect(
		runner.sqlQuery({
			query: 'insert into counters (value) values (?)',
			params: [5],
			writable: true,
		}),
	).resolves.toMatchObject({ rowsWritten: 1 })
	await expect(
		runner.sqlQuery({ query: 'select value from counters order by id asc' }),
	).resolves.toEqual({
		columns: ['value'],
		rows: [{ value: 5 }],
		rowCount: 1,
		rowsRead: 1,
		rowsWritten: 0,
		truncated: false,
		warning: null,
	})

	await runInDurableObject(
		storageRunnerStub('user-123', storageId),
		async (instance: StorageRunner, state) => {
			expect(instance).toBeInstanceOf(StorageRunner)
			expect(state.storage.sql.databaseSize).toBeGreaterThan(0)
		},
	)
})

test('sqlQuery caps large result sets and still finishes RETURNING writes', async () => {
	await ensureStorageRunnerTestSchema()
	const runner = runnerFor('user-123')
	const sqlQueryRowCap = 1_000
	const seq = (tail: string) => `with recursive seq(i) as (
			select 1
			union all
			select i + 1 from seq where i < ?
		)
		${tail}`

	await runner.sqlQuery({
		query:
			'create table if not exists bulk_rows (id integer primary key, value integer)',
		writable: true,
	})
	const overCap = sqlQueryRowCap + 25
	await runner.sqlQuery({
		query: seq('insert into bulk_rows (value) select i from seq'),
		params: [overCap],
		writable: true,
	})

	const result = await runner.sqlQuery({
		query: 'select value from bulk_rows order by id asc',
	})
	expect(result.truncated).toBe(true)
	expect(result.rowCount).toBe(sqlQueryRowCap)
	expect(result.rows).toHaveLength(sqlQueryRowCap)
	expect(result.rows[0]).toEqual({ value: 1 })
	expect(result.rows.at(-1)).toEqual({ value: sqlQueryRowCap })

	const exact = await runner.sqlQuery({
		query: 'select value from bulk_rows order by id asc limit ?',
		params: [sqlQueryRowCap],
	})
	expect(exact.truncated).toBe(false)
	expect(exact.rowCount).toBe(sqlQueryRowCap)

	// packageStorage always sends writable:true; WITH … SELECT must still
	// abort at the row cap (not drain the recursive cursor to completion).
	const cteRead = await runner.sqlQuery({
		query: seq('select i as value from seq'),
		params: [overCap],
		writable: true,
	})
	expect(cteRead.truncated).toBe(true)
	expect(cteRead.rowCount).toBe(sqlQueryRowCap)
	expect(cteRead.rowsRead).toBeLessThan(overCap)

	await runner.sqlQuery({
		query:
			'create table if not exists returning_bulk (id integer primary key, value integer)',
		writable: true,
	})
	const returningOverCap = sqlQueryRowCap + 40
	const inserted = await runner.sqlQuery({
		query: seq(
			'insert into returning_bulk (value) select i from seq returning value',
		),
		params: [returningOverCap],
		writable: true,
	})
	expect(inserted.truncated).toBe(true)
	expect(inserted.rowCount).toBe(sqlQueryRowCap)
	expect(inserted.rowsWritten).toBeGreaterThanOrEqual(returningOverCap)

	const count = await runner.sqlQuery({
		query: 'select count(*) as n from returning_bulk',
	})
	expect(count.rows[0]).toEqual({ n: returningOverCap })
})

test('storage runner enforces read-only SQL policy for mutations, multi-statement queries, and literal semicolons', async () => {
	await ensureStorageRunnerTestSchema()
	const storageId = createExecuteStorageId()
	const runner = runnerFor('user-123', storageId)
	// Rejections that cross the test RPC stub surface twice inside workerd and
	// print `uncaught exception` noise, so run the intentionally failing
	// queries inside the Durable Object instead.
	const failingStub = storageRunnerStub('user-123', storageId)
	const expectReadOnlyDenied = (query: string) =>
		runInDurableObject(failingStub, async (instance: StorageRunner) => {
			await expect(
				instance.sqlQuery({ query, writable: false }),
			).rejects.toThrow(readOnlyStorageSqlDeniedMessage)
		})

	await expectReadOnlyDenied('delete from counters')
	await runner.setValue({ key: 'counter', value: 1 })
	await expectReadOnlyDenied('select 1 as ok; delete from sqlite_schema')
	await expect(runner.getValue({ key: 'counter' })).resolves.toEqual({
		key: 'counter',
		value: 1,
	})

	await expect(
		runner.sqlQuery({ query: "select 'a;b' as val", writable: false }),
	).resolves.toEqual({
		columns: ['val'],
		rows: [{ val: 'a;b' }],
		rowCount: 1,
		rowsRead: 0,
		rowsWritten: 0,
		truncated: false,
		warning: null,
	})
})

test('storage runner registers buckets on writes but not on reads', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-register-${crypto.randomUUID()}`
	const writeStorageId = createExecuteStorageId()
	const reader = runnerFor(userId)

	await reader.getValue({ key: 'missing' })
	await reader.listValues({ pageSize: 10 })
	await reader.exportStorage({ pageSize: 10 })
	await reader.sqlQuery({ query: 'select 1 as ok', writable: false })
	await expect(bucketIds(userId)).resolves.toEqual([])

	await runnerFor(userId, writeStorageId).setValue({
		key: 'counter',
		value: 1,
	})
	await expect(bucketIds(userId)).resolves.toEqual([writeStorageId])

	// The mutating write also persists this bucket's byte estimate on its
	// inventory row so entitlement baselines can read it without a DO probe.
	const estimates = await listUserStorageBucketEstimates({
		env,
		userId: ownerIdFromStored(userId),
	})
	expect(estimates).toHaveLength(1)
	expect(estimates[0]?.storageId).toBe(writeStorageId)
	expect(estimates[0]?.estimatedBytes).toBeGreaterThan(0)

	const probeUserId = ownerIdFromStored(
		`storage-empty-probe-${crypto.randomUUID()}`,
	)
	const probe = storageRunnerRpc({
		env,
		userId: probeUserId,
		storageId: crypto.randomUUID(),
	})
	await expect(probe.getEstimatedBytes()).resolves.toMatchObject({
		estimatedBytes: emptyStorageRunnerEstimatedBytes,
	})
	await expect(bucketIds(probeUserId)).resolves.toEqual([])
})

test('storage runner dedupes bucket registration to one D1 write per isolate', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-dedupe-${crypto.randomUUID()}`
	const storageId = createExecuteStorageId()
	let insertCount = 0
	using _prepare = withPatchedDbPrepare(
		env.APP_DB,
		(originalPrepare) => (sql: string) => {
			if (sql.includes('INSERT INTO user_storage_buckets')) insertCount += 1
			return originalPrepare(sql)
		},
	)

	const runner = runnerFor(userId, storageId)
	await runner.setValue({ key: 'a', value: 1 })
	await runner.setValue({ key: 'b', value: 2 })
	await runner.deleteValue({ key: 'a' })
	await runner.sqlQuery({
		query: 'create table if not exists t (id integer primary key)',
		writable: true,
	})
	await expect(bucketIds(userId)).resolves.toEqual([storageId])
	expect(insertCount).toBe(1)
})

test('metered StorageRunner RpcStub get/set/list/delete stay callable and reject Proxies on write', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = ownerIdFromStored(`storage-metered-${crypto.randomUUID()}`)
	const runner = createMeteredDurableObjectStub({
		env: { USAGE_EVENTS: { writeDataPoint() {} } },
		userId,
		doClass: 'StorageRunner',
		stub: storageRunnerNamespace.get(
			storageRunnerNamespace.idFromName(
				storageRunnerDurableObjectName(userId, createExecuteStorageId()),
			),
		),
	})
	const roster = { bots: ['cole'], count: 1 }

	await expect(runner.getValue({ key: 'missing-key' })).resolves.toEqual({
		key: 'missing-key',
		value: null,
	})
	await expect(
		runner.setValue({ key: 'note', value: 'plain-string' }),
	).resolves.toEqual({ ok: true, key: 'note' })
	await expect(
		runner.setValue({ key: 'roster', value: roster }),
	).resolves.toEqual({ ok: true, key: 'roster' })
	await expect(runner.getValue({ key: 'note' })).resolves.toEqual({
		key: 'note',
		value: 'plain-string',
	})
	await expect(runner.listValues({ pageSize: 10 })).resolves.toMatchObject({
		entries: [
			{ key: 'note', value: 'plain-string' },
			{ key: 'roster', value: roster },
		],
		truncated: false,
	})
	await expect(runner.deleteValue({ key: 'note' })).resolves.toEqual({
		ok: true,
		key: 'note',
		deleted: true,
	})
	await expect(runner.getValue({ key: 'note' })).resolves.toEqual({
		key: 'note',
		value: null,
	})

	const tools = writableStorageTools({
		env,
		userId,
		storageId: createExecuteStorageId(),
		writable: true,
	})
	await expect(tools.storageGet({ key: 'fresh-missing' })).resolves.toEqual({
		key: 'fresh-missing',
		value: null,
	})
	await expect(
		tools.storageSet({ key: 'poison', value: new Proxy({ leaked: true }, {}) }),
	).rejects.toThrow(storageValueNotCloneableMessage)
	await expect(tools.storageGet({ key: 'poison' })).resolves.toEqual({
		key: 'poison',
		value: null,
	})
	await expect(
		tools.storageSet({ key: 'ok', value: { saved: true } }),
	).resolves.toEqual({ ok: true, key: 'ok' })
	await expect(tools.storageList({ pageSize: 10 })).resolves.toMatchObject({
		entries: [{ key: 'ok', value: { saved: true } }],
	})
	await expect(tools.storageDelete({ key: 'ok' })).resolves.toEqual({
		ok: true,
		key: 'ok',
		deleted: true,
	})

	// Production call sites go through storageRunnerRpc, which wraps the
	// stub only when env.USAGE_EVENTS is bound. Local workers env omits
	// that binding, so the factory path must be forced here — otherwise
	// this suite never sees the metered Proxy that production uses on
	// every export / subscription / job StorageRunner call.
	const meteredEnv = new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'USAGE_EVENTS') return { writeDataPoint() {} }
			return Reflect.get(target, prop, receiver)
		},
	})
	const factoryUserId = ownerIdFromStored(
		`storage-metered-factory-${crypto.randomUUID()}`,
	)
	const factoryRunner = storageRunnerRpc({
		env: meteredEnv,
		userId: factoryUserId,
		storageId: createExecuteStorageId(),
	})
	await expect(
		factoryRunner.getValue({ key: 'missing-via-factory' }),
	).resolves.toEqual({ key: 'missing-via-factory', value: null })
	await expect(
		factoryRunner.sqlQuery({
			query: 'create table if not exists metered_t (id integer primary key)',
			writable: true,
		}),
	).resolves.toMatchObject({
		columns: expect.any(Array),
		rows: expect.any(Array),
	})
	const factoryTools = writableStorageTools({
		env: meteredEnv,
		userId: factoryUserId,
		storageId: createExecuteStorageId(),
		writable: true,
	})
	await expect(
		factoryTools.storageGet({ key: 'factory-fresh-missing' }),
	).resolves.toEqual({ key: 'factory-fresh-missing', value: null })
	await expect(
		factoryTools.storageSet({ key: 'factory-ok', value: { saved: true } }),
	).resolves.toEqual({ ok: true, key: 'factory-ok' })
	await expect(factoryTools.storageGet({ key: 'factory-ok' })).resolves.toEqual(
		{ key: 'factory-ok', value: { saved: true } },
	)
})

test('clearStorage during account-deletion purge must not recreate ownership rows', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-delete-race-${crypto.randomUUID()}`
	const storageId = createExecuteStorageId()
	const runner = runnerFor(userId, storageId)

	await runner.setValue({ key: 'keep-until-purge', value: 1 })
	await expect(bucketIds(userId)).resolves.toEqual([storageId])

	// Account deletion often runs in a fresh isolate, so in-memory dedupe
	// cannot paper over a clearStorage registration race.
	clearStorageBucketRegistrationDedupeForTests()

	// Hold any ownership upsert until after the D1 delete so a fire-and-forget
	// clearStorage registration cannot win the race before the assertion.
	let releaseInsert = () => {}
	const insertGate = new Promise<void>((resolve) => {
		releaseInsert = resolve
	})
	using _prepare = withPatchedDbPrepare(
		env.APP_DB,
		(originalPrepare) => (sql: string) => {
			const statement = originalPrepare(sql)
			if (!sql.includes('INSERT INTO user_storage_buckets')) return statement
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						async run() {
							await insertGate
							return await bound.run()
						},
					}
				},
			} as unknown as D1PreparedStatement
		},
	)

	try {
		await runner.clearStorage()
		await env.APP_DB.prepare(
			`DELETE FROM user_storage_buckets WHERE user_id = ?`,
		)
			.bind(userId)
			.run()
		releaseInsert()
		await expect(bucketIds(userId)).resolves.toEqual([])
	} finally {
		releaseInsert()
	}
})

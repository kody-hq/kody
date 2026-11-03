import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
	backupBlobKey,
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	stagingArtifactsIndexKey,
	stagingMailboxDumpKey,
	stagingMailboxIndexKey,
	stagingR2IndexKey,
	stagingRunLogDumpKey,
	stagingRunLogIndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	stagingSummaryKey,
} from '@kody-internal/shared/backup-staging.ts'
import { test, vi } from 'vitest'

import {
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	manifest,
	putSqlStatsFixture,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	objectKeyForBookmark,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { readFullManifest, sealFullBackupDay } from './seal-full-backup.ts'

function sha256Text(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

const dumpBodies = {
	storage: '{"key":"a","valueJson":"1"}\n',
	mailbox: '{"kind":"thread","row":{"id":"thread-1"}}\n',
	runLog:
		'{"kind":"activationMilestone","row":{"milestone":"package_activated"}}\n',
} as const
const sealedDumpKeys = (day: string) => ({
	storage: `daily/full/${day}/storage/${encodeURIComponent('user-storage-1')}.ndjson`,
	mailbox: `daily/full/${day}/mailbox/${encodeURIComponent('user-owner-1')}.ndjson`,
	runLog: `daily/full/${day}/run-log/${encodeURIComponent('user-owner-1')}.ndjson`,
})
const jobsSource = {
	id: '44444444-4444-4444-8444-444444444444',
	name: 'kody-jobs',
}

async function putBody(bucket: MemoryBucket, objectKey: string, body: string) {
	await bucket.put(objectKey, body)
	return { objectKey, bytes: body.length, sha256: sha256Text(body) }
}

async function putD1DayManifest(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	day: string,
	sqlBody: string,
) {
	const payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sqlKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	await bucket.put(sqlKey, sqlBody)
	const template = manifest({
		bytes: sqlBody.length,
		sha256: sha256Text(sqlBody),
		r2Etag: createHash('md5').update(sqlBody).digest('hex'),
	})
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		payload.manifestKey,
		signedManifest({
			...template.payload,
			source: {
				...template.payload.source,
				databaseId: env.SOURCE_DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
			},
			export: {
				bookmark: 'bookmark-1',
				scheduledAt: `${day}T02:15:00.000Z`,
				startedAt: `${day}T02:15:01.000Z`,
				completedAt: `${day}T02:16:00.000Z`,
			},
			sql: { ...template.payload.sql, objectKey: sqlKey },
		}),
	)
	return { sqlKey, manifestKey: payload.manifestKey }
}

async function seedCompleteDay(
	bucket: MemoryBucket,
	day = '2026-07-22',
	options: { duplicateIndexEntry?: boolean } = {},
) {
	const env = environment(bucket)
	const { sqlKey } = await putD1DayManifest(
		bucket,
		env,
		day,
		'CREATE TABLE t(id INTEGER);\n',
	)
	const ownerId = ownerIdFromStored('user-owner-1')
	const index = (entries: Array<unknown>) =>
		JSON.stringify({ schemaVersion: backupStagingSchemaVersion, day, entries })
	const storageEntry = {
		storageId: 'user-storage-1',
		entryCount: 1,
		...(await putBody(
			bucket,
			stagingStorageDumpKey(day, 'user-storage-1'),
			dumpBodies.storage,
		)),
	}
	const mailboxEntry = {
		ownerId,
		entryCount: 1,
		...(await putBody(
			bucket,
			stagingMailboxDumpKey(day, ownerId),
			dumpBodies.mailbox,
		)),
	}
	const runLogEntry = {
		ownerId,
		entryCount: 1,
		...(await putBody(
			bucket,
			stagingRunLogDumpKey(day, ownerId),
			dumpBodies.runLog,
		)),
	}
	const blobHash = 'e'.repeat(64)
	await bucket.put(backupBlobKey(blobHash), 'x')
	const summary = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		startedAt: `${day}T03:00:00.000Z`,
		completedAt: `${day}T03:05:00.000Z`,
		buildCommit: 'abc123',
		mailboxIndex: await putBody(
			bucket,
			stagingMailboxIndexKey(day),
			index([mailboxEntry]),
		),
		runLogIndex: await putBody(
			bucket,
			stagingRunLogIndexKey(day),
			index([runLogEntry]),
		),
		storageIndex: await putBody(
			bucket,
			stagingStorageIndexKey(day),
			index(
				options.duplicateIndexEntry
					? [storageEntry, storageEntry]
					: [storageEntry],
			),
		),
		r2Indexes: {
			'email-blobs': await putBody(
				bucket,
				stagingR2IndexKey(day, 'email-blobs'),
				`{"key":"blob","size":1,"sha256":"${blobHash}"}\n`,
			),
		},
		artifactsIndex: await putBody(
			bucket,
			stagingArtifactsIndexKey(day),
			index([]),
		),
		blobsWritten: 1,
		blobsReused: 0,
		warnings: [],
	}
	await bucket.put(stagingSummaryKey(day), JSON.stringify(summary))
	return {
		env,
		day,
		sqlKey,
		seal: (time = '04:00') =>
			sealFullBackupDay(env, day, new Date(`${day}T${time}:00.000Z`)),
		sealedManifest: () =>
			readFullManifest(
				bucket as unknown as R2Bucket,
				sealedFullManifestKey(day),
			),
	}
}

function addJobsSource(env: BackupEnvironment) {
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		jobsSource,
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${jobsSource.id}`
}

const alreadySealed = (day: string) => ({
	kind: 'sealed',
	day,
	manifestKey: sealedFullManifestKey(day),
	alreadySealed: true,
})

test('sealFullBackupDay seals a complete day, is idempotent, short-circuits sealed days, and adopts a concurrent winner', async () => {
	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket)
	const { env, day } = seeded
	const first = await seeded.seal()
	assert.equal(first.kind, 'sealed')
	if (first.kind !== 'sealed') return
	assert.equal(first.alreadySealed, false)
	const sealed = await seeded.sealedManifest()
	assert.ok(sealed)
	assert.equal(sealed?.payload.day, day)
	assert.equal(
		sealed?.payload.schemaVersion === 2
			? sealed.payload.mailboxIndex.objectKey
			: null,
		`daily/full/${day}/mailbox-index.json`,
	)
	assert.ok(await bucket.head(sealedDumpKeys(day).mailbox))
	assert.equal(sealed?.payload.d1Sources?.length, 1)
	assert.equal(
		sealed?.payload.d1Sources?.[0]?.databaseId,
		env.SOURCE_DATABASE_ID,
	)
	assert.equal(
		sealed?.payload.d1Sources?.[0]?.manifestKey,
		backupPayload(env, new Date(`${day}T12:00:00.000Z`)).manifestKey,
	)

	assert.deepEqual(await seeded.seal('04:01'), alreadySealed(day))

	const manifestKey = sealedFullManifestKey(day)
	const winnerText = await (await bucket.get(manifestKey))!.text()
	await bucket.delete(manifestKey)
	bucket.raceOnNextPut(manifestKey, winnerText)
	const raced = await seeded.seal('04:05')
	assert.equal(raced.kind, 'sealed')
	if (raced.kind !== 'sealed') return
	assert.equal(raced.alreadySealed, true)
	assert.equal(await (await bucket.get(manifestKey))?.text(), winnerText)

	// Already-sealed days short-circuit before a newly configured source
	// (with no manifest yet) is checked.
	addJobsSource(env)
	assert.deepEqual(await seeded.seal('04:10'), alreadySealed(day))
})

test('sealFullBackupDay completes over locked partial state and duplicate index entries', async () => {
	// Reproduces the 2026-07-28 production wedge: the bucket-lock rule
	// rejects puts on existing keys with error 10069, the storage index
	// contained duplicate entries from mid-window inventory drift, and a
	// partial earlier attempt had already copied some sealed objects. The
	// seal must fall through to byte comparison in all three situations.
	const bucket = new MemoryBucket()
	bucket.enableLockPolicy()
	const seeded = await seedCompleteDay(bucket, '2026-07-22', {
		duplicateIndexEntry: true,
	})
	await bucket.put(sealedDumpKeys(seeded.day).storage, dumpBodies.storage)

	const result = await seeded.seal()
	assert.equal(result.kind, 'sealed')
	if (result.kind !== 'sealed') return
	assert.equal(result.alreadySealed, false)
	assert.equal((await seeded.sealedManifest())?.payload.day, seeded.day)
})

test('sealFullBackupDay resumes a locked partial day without re-getting dump bodies', async () => {
	// 2026-09-04 production wedge: hourly seal copied every daily/full
	// object then timed out before writing the signed manifest. Resume must
	// HEAD sealed keys and skip staging re-download + 10069 byte-compare for
	// dumps whose sealed size already matches the staging index entry.
	const bucket = new MemoryBucket()
	bucket.enableLockPolicy()
	const day = '2026-09-04'
	const seeded = await seedCompleteDay(bucket, day)
	await putSqlStatsFixture(bucket, day, seeded.sqlKey)

	const sealedKeys = sealedDumpKeys(day)
	await bucket.put(sealedKeys.storage, dumpBodies.storage)
	await bucket.put(sealedKeys.mailbox, dumpBodies.mailbox)
	await bucket.put(sealedKeys.runLog, dumpBodies.runLog)
	const putsBeforeSeal = bucket.puts.length

	const stagingDumpKeys = new Set([
		stagingStorageDumpKey(day, 'user-storage-1'),
		stagingMailboxDumpKey(day, 'user-owner-1'),
		stagingRunLogDumpKey(day, 'user-owner-1'),
	])
	const getKeys: Array<string> = []
	const originalGet = bucket.get.bind(bucket)
	bucket.get = async (key: string) => {
		getKeys.push(key)
		return originalGet(key)
	}

	const result = await seeded.seal('20:00')
	assert.equal(result.kind, 'sealed')
	if (result.kind !== 'sealed') return
	assert.equal(result.alreadySealed, false)
	assert.ok(await bucket.head(sealedFullManifestKey(day)))
	// Resume must not re-get dump bodies already sealed with matching size,
	// must skip the putImmutableBytes body compare, and must not re-put
	// already-sealed dumps under the lock policy.
	assert.deepEqual(
		getKeys.filter((key) => stagingDumpKeys.has(key)),
		[],
	)
	const sealedDumpKeySet = new Set<string>(Object.values(sealedKeys))
	assert.deepEqual(
		getKeys.filter((key) => sealedDumpKeySet.has(key)),
		[],
	)
	assert.deepEqual(
		bucket.puts
			.slice(putsBeforeSeal)
			.filter((entry) => sealedDumpKeySet.has(entry.key)),
		[],
	)
})

test('sealFullBackupDay fails closed on staging storage or mailbox sha mismatches', async () => {
	for (const [tamperKey, body] of [
		[stagingStorageIndexKey, '{"tampered":true}'],
		[
			(day: string) => stagingMailboxDumpKey(day, 'user-owner-1'),
			'{"tampered":true}\n',
		],
	] as const) {
		const bucket = new MemoryBucket()
		const seeded = await seedCompleteDay(bucket)
		await bucket.put(tamperKey(seeded.day), body)
		await assert.rejects(
			seeded.seal(),
			(error: unknown) =>
				error instanceof BackupError && error.code === 'staging-sha-mismatch',
		)
		assert.equal(await bucket.head(sealedFullManifestKey(seeded.day)), null)
	}
})

test('sealFullBackupDay refuses missing or unrestorable SQL stats before sealing', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const putBadStats = (bucket: MemoryBucket, day: string, sqlKey: string) =>
		bucket.put(
			`${sqlKey}.stats.json`,
			JSON.stringify(badSqlStatsFixture(day, sqlKey)),
		)

	for (const [reason, prepare] of [
		['backup-sql-stats-missing', async () => undefined],
		['backup-unrestorable-statements', putBadStats],
	] as const) {
		const bucket = new MemoryBucket()
		const seeded = await seedCompleteDay(bucket, '2026-07-31')
		await prepare(bucket, seeded.day, seeded.sqlKey)
		assert.deepEqual(await seeded.seal(), {
			kind: 'incomplete',
			day: seeded.day,
			reason,
		})
		assert.equal(await bucket.head(sealedFullManifestKey(seeded.day)), null)
		const record = JSON.parse(
			String(consoleError.mock.calls.at(-1)?.[0]),
		) as Record<string, unknown>
		assert.equal(record.event, 'full-backup-seal-skipped')
		assert.equal(record.errorCode, reason)
	}

	// Stats that turn bad after sealing do not unseal the day.
	const sealedBucket = new MemoryBucket()
	const sealedDay = await seedCompleteDay(sealedBucket, '2026-07-31')
	await putSqlStatsFixture(sealedBucket, sealedDay.day, sealedDay.sqlKey)
	assert.equal((await sealedDay.seal()).kind, 'sealed')
	await putBadStats(sealedBucket, sealedDay.day, sealedDay.sqlKey)
	assert.deepEqual(await sealedDay.seal('04:01'), alreadySealed(sealedDay.day))
})

test('sealFullBackupDay is incomplete when the 501st referenced blob is missing', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket)
	const lines: Array<string> = []
	for (let index = 0; index < 501; index += 1) {
		const hash = index.toString(16).padStart(64, '0')
		lines.push(
			JSON.stringify({ key: `blob-${String(index)}`, size: 1, sha256: hash }),
		)
		// Intentionally omit blob 500 so verification past the old sample cap fails.
		if (index < 500) await bucket.put(backupBlobKey(hash), 'x')
	}
	const summaryKey = stagingSummaryKey(seeded.day)
	const summary = (await (await bucket.get(summaryKey))!.json()) as {
		r2Indexes: Record<string, unknown>
	}
	summary.r2Indexes['email-blobs'] = await putBody(
		bucket,
		stagingR2IndexKey(seeded.day, 'email-blobs'),
		`${lines.join('\n')}\n`,
	)
	await bucket.put(summaryKey, JSON.stringify(summary))
	assert.deepEqual(await seeded.seal(), {
		kind: 'incomplete',
		day: seeded.day,
		reason: 'blob-missing',
	})
	assert.equal(await bucket.head(sealedFullManifestKey(seeded.day)), null)
})

test('sealFullBackupDay requires a restorable manifest for every SOURCE_DATABASES entry and records each one', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket)
	addJobsSource(seeded.env)
	assert.deepEqual(await seeded.seal(), {
		kind: 'incomplete',
		day: seeded.day,
		reason: 'd1-manifest-missing',
	})
	assert.equal(await bucket.head(sealedFullManifestKey(seeded.day)), null)
	assert.equal(consoleError.mock.calls.length, 1)

	const jobs = await putD1DayManifest(
		bucket,
		bindSourceDatabase(seeded.env, jobsSource),
		seeded.day,
		'CREATE TABLE jobs(id INTEGER);\n',
	)
	const result = await seeded.seal('04:01')
	assert.equal(result.kind, 'sealed')
	if (result.kind !== 'sealed') return
	assert.equal(result.alreadySealed, false)
	assert.deepEqual(
		(await seeded.sealedManifest())?.payload.d1Sources?.map((source) => ({
			databaseId: source.databaseId,
			databaseName: source.databaseName,
			manifestKey: source.manifestKey,
		})),
		[
			{
				databaseId: seeded.env.SOURCE_DATABASE_ID,
				databaseName: seeded.env.SOURCE_DATABASE_NAME,
				manifestKey: backupPayload(
					seeded.env,
					new Date(`${seeded.day}T12:00:00.000Z`),
				).manifestKey,
			},
			{
				databaseId: jobsSource.id,
				databaseName: 'kody-jobs',
				manifestKey: jobs.manifestKey,
			},
		],
	)
})

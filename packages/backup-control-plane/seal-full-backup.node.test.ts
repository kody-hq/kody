import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
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
	putPacedSeal,
} from './backup-control-plane-test-support.ts'
import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	objectKeyForBookmark,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { createR2CallBudget } from './r2-call-budget.ts'
import {
	readFullManifest,
	sealFullBackupDay,
	sealRecentCompleteDays,
} from './seal-full-backup.ts'
import {
	captureFullSealBlocked,
	captureSealScanSubrequestLimit,
} from './sentry.ts'

vi.mock('./sentry.ts', () => ({
	captureFullSealBlocked: vi.fn(),
	captureSealScanSubrequestLimit: vi.fn(),
}))

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

const auditSource = {
	id: '55555555-5555-4555-8555-555555555555',
	name: 'kody-audit',
}

/** Production shape: APP + AUDIT + JOBS paced, REST export off for all. */
function usePacedOnlySources(env: BackupEnvironment) {
	const app = { id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME }
	env.SOURCE_DATABASES = JSON.stringify([
		{ ...app, restExport: false },
		{ ...jobsSource, restExport: false },
	])
	env.D1_PACED_SOURCES = JSON.stringify([app, auditSource, jobsSource])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${app.id},${jobsSource.id}`
	return [app, auditSource, jobsSource]
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
	options: { duplicateIndexEntry?: boolean; blobCount?: number } = {},
) {
	const env = environment(bucket)
	await putPacedSeal(
		bucket,
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		day,
	)
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
	const blobHashes = Array.from({ length: options.blobCount ?? 1 }, (_, i) =>
		i.toString(16).padStart(64, 'e'),
	)
	for (const blobHash of blobHashes) {
		await bucket.put(backupBlobKey(blobHash), 'x')
	}
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
				blobHashes
					.map(
						(blobHash, i) =>
							`{"key":"blob-${i}","size":1,"sha256":"${blobHash}"}\n`,
					)
					.join(''),
			),
		},
		artifactsIndex: await putBody(
			bucket,
			stagingArtifactsIndexKey(day),
			index([]),
		),
		blobsWritten: blobHashes.length,
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
		sealed?.payload.schemaVersion === 3
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

test('missing or unrestorable REST SQL stats omit REST D1 evidence without blocking the seal', async () => {
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
		assert.equal((await seeded.seal()).kind, 'sealed')
		const payload = (await seeded.sealedManifest())?.payload
		assert.equal(payload?.d1ManifestKey, undefined)
		assert.equal(payload?.schemaVersion === 3 ? payload.d1Paced.length : 0, 1)
		const omitted = consoleLog.mock.calls
			.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
			.filter((record) => record.event === 'full-backup-rest-d1-omitted')
			.at(-1)
		assert.equal(omitted?.errorCode, reason)
	}
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

test('REST D1 evidence is recorded only when every REST source has a restorable manifest', async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const partial = await seedCompleteDay(new MemoryBucket())
	addJobsSource(partial.env)
	// A REST export still in flight holds the seal until 12:00 UTC.
	assert.deepEqual(await partial.seal('04:00'), {
		kind: 'incomplete',
		day: partial.day,
		reason: 'rest-d1-pending',
	})
	assert.equal((await partial.seal('12:00')).kind, 'sealed')
	assert.equal((await partial.sealedManifest())?.payload.d1Sources, undefined)

	const corrupt = new MemoryBucket()
	const corruptDay = await seedCompleteDay(corrupt)
	await corrupt.put(
		backupPayload(corruptDay.env, new Date(`${corruptDay.day}T12:00:00.000Z`))
			.manifestKey,
		'not json',
	)
	assert.equal((await corruptDay.seal()).kind, 'sealed')
	assert.equal(
		(await corruptDay.sealedManifest())?.payload.d1ManifestKey,
		undefined,
	)

	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket)
	addJobsSource(seeded.env)
	const jobs = await putD1DayManifest(
		bucket,
		bindSourceDatabase(seeded.env, jobsSource),
		seeded.day,
		'CREATE TABLE jobs(id INTEGER);\n',
	)
	const result = await seeded.seal()
	assert.equal(result.kind, 'sealed')
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

test('with restExport:false on every source, the full seal seals from the paced lane alone', async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket, '2026-11-17')
	const sources = usePacedOnlySources(seeded.env)
	const seals: Array<{ manifestKey: string; manifestSha256: string }> = []
	for (const source of sources) {
		seals.push(await putPacedSeal(bucket, source, seeded.day))
	}

	const result = await seeded.seal()
	assert.equal(result.kind, 'sealed')
	const payload = (await seeded.sealedManifest())?.payload
	assert.equal(payload?.schemaVersion, 3)
	assert.deepEqual(
		payload?.schemaVersion === 3 ? payload.d1Paced : null,
		sources.map((source, index) => ({
			databaseId: source.id,
			databaseName: source.name,
			...seals[index],
		})),
	)
	assert.equal(payload?.d1ManifestKey, undefined)
	assert.equal(payload?.d1Sources, undefined)
})

test('a missing paced seal blocks the full seal and opens one Sentry issue per source', async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const seeded = await seedCompleteDay(bucket, '2026-11-17')
	usePacedOnlySources(seeded.env)
	await putPacedSeal(bucket, jobsSource, seeded.day)

	assert.deepEqual(await seeded.seal(), {
		kind: 'incomplete',
		day: seeded.day,
		reason: 'paced-d1-seal-missing',
		source: 'kody-audit',
	})
	assert.equal(await bucket.head(sealedFullManifestKey(seeded.day)), null)

	await sealRecentCompleteDays(
		seeded.env,
		new Date('2026-11-18T11:45:00.000Z'),
		2,
	)
	assert.deepEqual(vi.mocked(captureFullSealBlocked).mock.calls, [
		[
			{
				day: seeded.day,
				reason: 'paced-d1-seal-missing',
				source: 'kody-audit',
			},
		],
	])
})

test('a persistent R2 put failure on one day stays isolated and is logged with its cause', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const failing = await seedCompleteDay(bucket, '2026-07-22')
	const healthy = await seedCompleteDay(bucket, '2026-07-21')
	const put = bucket.put.bind(bucket)
	bucket.put = async (key, value, options) => {
		if (key.startsWith('daily/full/2026-07-22/')) {
			throw new Error(
				'put: We encountered an internal error. Please try again. (10001)',
			)
		}
		return put(key, value, options)
	}
	vi.useFakeTimers({ toFake: ['setTimeout'] })
	const scan = sealRecentCompleteDays(
		failing.env,
		new Date('2026-07-22T13:00:00.000Z'),
		2,
	)
	const rejected = assert.rejects(
		scan,
		(error: unknown) =>
			error instanceof BackupError && error.code === 'r2-platform-error',
	)
	let settled = false
	void rejected.finally(() => (settled = true))
	// Signing and hashing do real async work between retry waits.
	const realDeadline = performance.now() + 10_000
	while (!settled && performance.now() < realDeadline) {
		await vi.advanceTimersByTimeAsync(100)
		await new Promise((resolve) => setImmediate(resolve))
	}
	await rejected
	vi.useRealTimers()
	const failures = consoleError.mock.calls
		.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
		.filter((record) => record.event === 'full-backup-seal-failure')
	assert.deepEqual(failures, [
		{
			event: 'full-backup-seal-failure',
			status: 'failure',
			day: failing.day,
			errorCode: 'r2-platform-error',
		},
	])
	assert.equal((await healthy.sealedManifest())?.payload.day, healthy.day)
	vi.restoreAllMocks()
})

function scanLogs(spy: { mock: { calls: Array<Array<unknown>> } }) {
	return spy.mock.calls
		.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
		.filter((record) => record.event === 'full-backup-seal-scan-stopped')
}

test('a scan with more work than its R2 call budget stops cleanly and the next run finishes', async () => {
	const consoleLog = vi
		.spyOn(console, 'log')
		.mockImplementation(() => undefined)
	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)
	const measure = new MemoryBucket()
	const measured = await seedCompleteDay(measure, '2026-07-22')
	const counter = createR2CallBudget(
		measure as unknown as R2Bucket,
		Number.MAX_SAFE_INTEGER,
	)
	await sealFullBackupDay(
		{ ...measured.env, BACKUP_BUCKET: counter.bucket },
		measured.day,
		new Date('2026-07-22T13:00:00.000Z'),
	)
	const oneDayCalls = counter.used()

	const bucket = new MemoryBucket()
	const today = await seedCompleteDay(bucket, '2026-07-22')
	const yesterday = await seedCompleteDay(bucket, '2026-07-21')
	const scheduledAt = new Date('2026-07-22T13:00:00.000Z')
	const budget = oneDayCalls + 3

	await sealRecentCompleteDays(today.env, scheduledAt, 2, budget)
	assert.equal((await today.sealedManifest())?.payload.day, today.day)
	assert.equal(await yesterday.sealedManifest(), null)
	assert.deepEqual(scanLogs(consoleLog), [
		{
			event: 'full-backup-seal-scan-stopped',
			status: 'success',
			day: yesterday.day,
			errorCode: 'r2-call-budget-exhausted',
			r2Calls: budget,
		},
	])
	assert.deepEqual(vi.mocked(captureFullSealBlocked).mock.calls, [
		[{ day: yesterday.day, reason: 'r2-call-budget-exhausted' }],
	])
	assert.equal(consoleError.mock.calls.length, 0)

	await sealRecentCompleteDays(today.env, scheduledAt, 2, budget)
	assert.equal((await yesterday.sealedManifest())?.payload.day, yesterday.day)
	assert.equal(scanLogs(consoleLog).length, 1)
	vi.restoreAllMocks()
	vi.mocked(captureFullSealBlocked).mockClear()
})

test('the Workers subrequest limit stops the scan without retrying or dispatching more calls', async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)
	const memory = new MemoryBucket()
	const today = await seedCompleteDay(memory, '2026-07-22', { blobCount: 200 })
	await seedCompleteDay(memory, '2026-07-21')
	await seedCompleteDay(memory, '2026-07-20')
	const blobPrefix = backupBlobKey('e'.repeat(64)).slice(0, -64)
	let limitReached = false
	let callsAfterLimit = 0
	const limited = new Proxy(memory, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown
			if (
				typeof value !== 'function' ||
				!['head', 'get', 'put', 'list', 'delete'].includes(String(property))
			) {
				return value
			}
			return async (...args: Array<unknown>) => {
				if (property === 'head' && String(args[0]).startsWith(blobPrefix)) {
					limitReached = true
				}
				if (limitReached) {
					callsAfterLimit += 1
					throw new Error(
						'Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits',
					)
				}
				return (value as (...input: Array<unknown>) => unknown).apply(
					target,
					args,
				)
			}
		},
	})

	await sealRecentCompleteDays(
		{ ...today.env, BACKUP_BUCKET: limited as unknown as R2Bucket },
		new Date('2026-07-22T13:00:00.000Z'),
		3,
	)

	// Only the blob HEADs already in flight (pool of 32) fail; none of the
	// other 168 blobs, no retries, and no later days.
	assert.ok(callsAfterLimit <= 32, `${callsAfterLimit} calls after the limit`)
	const stopped = scanLogs(consoleError)
	assert.equal(stopped.length, 1)
	assert.equal(stopped[0]?.day, today.day)
	assert.equal(stopped[0]?.errorCode, 'worker-subrequest-limit')
	assert.deepEqual(vi.mocked(captureSealScanSubrequestLimit).mock.calls, [
		[{ day: today.day, r2Calls: stopped[0]?.r2Calls }],
	])
	assert.equal(await today.sealedManifest(), null)
	vi.restoreAllMocks()
})

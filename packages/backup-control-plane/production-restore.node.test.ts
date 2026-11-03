import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { serializeBackupFullManifest } from '@kody-internal/shared/backup-full-manifest.ts'
import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'
import { test, vi } from 'vitest'

import {
	ACCOUNT_ID,
	DATABASE_ID,
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	exportEnvelope,
	manifest,
	backupError,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	objectKeyForBookmark,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { d1ImportForeignKeysOffPrefix } from './d1-import-api.ts'
import { signBackupFullManifest } from './full-manifest-signing.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import {
	runProductionRestore,
	restoreProgressFailsWorkflow,
} from './production-restore.ts'

function sha256Text(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

const JOBS_DATABASE_ID = '44444444-4444-4444-8444-444444444444'
const safetySql = 'CREATE TABLE safety(id INTEGER);\n'

async function putSealedFullManifest(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	day: string,
	d1: Pick<
		Parameters<typeof signBackupFullManifest>[1],
		'd1ManifestKey' | 'd1ManifestSha256' | 'd1Sources'
	>,
) {
	const index = (name: string, char: string) => ({
		objectKey: `daily/full/${day}/${name}.json`,
		bytes: 2,
		sha256: char.repeat(64),
	})
	const full = await signBackupFullManifest(env, {
		day,
		...d1,
		mailboxIndex: index('mailbox-index', 'd'),
		runLogIndex: index('run-log-index', 'e'),
		storageIndex: index('storage-index', 'b'),
		r2Indexes: {},
		artifactsIndex: index('artifacts-index', 'c'),
		sealedAt: `${day}T04:00:00.000Z`,
		buildCommit: 'abc123',
	})
	await bucket.put(
		sealedFullManifestKey(day),
		serializeBackupFullManifest(full),
	)
}

async function seedSealedRestoreDay(bucket: MemoryBucket, day = '2026-07-22') {
	const env = environment(bucket)
	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sqlBody = 'CREATE TABLE t(id INTEGER);\n'
	const preparedImportMd5 = createHash('md5')
		.update(d1ImportForeignKeysOffPrefix)
		.update(sqlBody)
		.digest('hex')
	const template = manifest({
		bytes: sqlBody.length,
		sha256: sha256Text(sqlBody),
		r2Etag: createHash('md5').update(sqlBody).digest('hex'),
	})
	const sqlObjectKey = template.payload.sql.objectKey.replace('2026-07-22', day)
	await bucket.put(sqlObjectKey, sqlBody)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		d1Payload.manifestKey,
		signedManifest({
			...template.payload,
			sql: { ...template.payload.sql, objectKey: sqlObjectKey },
		}),
	)
	const appManifestKey = d1Payload.manifestKey
	const appManifestSha256 = sha256Text(
		await (await bucket.get(appManifestKey))!.text(),
	)
	await putSealedFullManifest(bucket, env, day, {
		d1ManifestKey: appManifestKey,
		d1ManifestSha256: appManifestSha256,
	})
	return {
		env,
		day,
		preparedImportMd5,
		sqlObjectKey,
		appManifestKey,
		appManifestSha256,
	}
}

function configureJobsDatabase(env: BackupEnvironment) {
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${JOBS_DATABASE_ID}`
}

/** Registers a jobs D1 manifest whose SQL object was never written. */
async function putJobsManifestWithoutSql(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	day: string,
) {
	const jobsEnv = bindSourceDatabase(env, {
		id: JOBS_DATABASE_ID,
		name: 'kody-jobs',
	})
	const jobsPayload = backupPayload(jobsEnv, new Date(`${day}T12:00:00.000Z`))
	const sqlBody = 'CREATE TABLE jobs(id INTEGER);\n'
	const sqlObjectKey = objectKeyForBookmark(
		jobsPayload.objectPrefix,
		'bookmark-1',
	)
	const sql = {
		bytes: sqlBody.length,
		sha256: sha256Text(sqlBody),
		r2Etag: createHash('md5').update(sqlBody).digest('hex'),
	}
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		jobsPayload.manifestKey,
		signedManifest({
			...manifest(sql).payload,
			source: {
				accountId: ACCOUNT_ID,
				databaseId: JOBS_DATABASE_ID,
				databaseName: 'kody-jobs',
			},
			sql: { objectKey: sqlObjectKey, ...sql },
		}),
	)
	const stored = await bucket.get(jobsPayload.manifestKey)
	return {
		manifestKey: jobsPayload.manifestKey,
		sqlObjectKey,
		storedText: await stored!.text(),
	}
}

function trackSqlObjectAccess(
	bucket: MemoryBucket,
	sqlObjectKeys: Array<string>,
): { heads: Array<string>; gets: Array<string> } {
	const tracked = new Set(sqlObjectKeys)
	const heads: Array<string> = []
	const gets: Array<string> = []
	const originalHead = bucket.head.bind(bucket)
	const originalGet = bucket.get.bind(bucket)
	bucket.head = async (key: string) => {
		if (tracked.has(key)) heads.push(key)
		return originalHead(key)
	}
	bucket.get = async (key: string) => {
		if (tracked.has(key)) gets.push(key)
		return originalGet(key)
	}
	return { heads, gets }
}

/** Fake Cloudflare export/import + primary dr-restore endpoints. */
function restoreFetcher(preparedImportMd5: string, warnings: Array<string>) {
	const state = { exportCalls: 0, importedDatabaseIds: [] as Array<string> }
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.includes('api.cloudflare.com') && url.includes('/export')) {
			state.exportCalls += 1
			return exportEnvelope(state.exportCalls === 1 ? 'active' : 'complete')
		}
		if (url.includes('download.example')) {
			return new Response(safetySql, {
				headers: { 'content-length': String(safetySql.length) },
			})
		}
		if (url.includes('/import')) {
			const { action } = JSON.parse(String(init?.body ?? '{}')) as {
				action?: string
			}
			if (action === 'init') {
				const match = /\/d1\/database\/([^/]+)\/import/.exec(url)
				if (match?.[1]) state.importedDatabaseIds.push(match[1])
				return Response.json({
					success: true,
					result: {
						upload_url: 'https://upload.example/sql',
						filename: 'import.sql',
					},
				})
			}
			return Response.json({
				success: true,
				result:
					action === 'ingest'
						? { at_bookmark: 'import-1', type: 'import' }
						: { status: 'complete', success: true, type: 'import' },
			})
		}
		if (url.includes('upload.example')) {
			return new Response(null, {
				status: 200,
				headers: { etag: `"${preparedImportMd5}"` },
			})
		}
		if (url.includes('/__maintenance/dr-restore')) {
			return Response.json({ done: true, progress: { step: 'done' }, warnings })
		}
		throw new Error(`unexpected fetch ${url}`)
	}
	return { state, fetcher }
}

const restoreOptions = (day: string, fetcher: typeof fetch) => ({
	now: new Date(`${day}T12:00:00.000Z`),
	sleep: async () => undefined,
	maxPollAttempts: 3,
	pollDelayMs: 1,
	fetcher,
})

test('runProductionRestore returns failed progress when dr-restore emits warnings', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, preparedImportMd5 } = await seedSealedRestoreDay(bucket)
	const { state, fetcher } = restoreFetcher(preparedImportMd5, [
		'storage-partial',
		'blob-skipped',
	])
	const progress = await runProductionRestore(
		env,
		{ day, requestedAt: `${day}T12:00:00.000Z` },
		restoreOptions(day, fetcher),
	)
	assert.equal(progress.phase, 'failed')
	assert.equal(progress.errorCode, 'dr-restore-warnings')
	assert.deepEqual(progress.warnings, ['storage-partial', 'blob-skipped'])
	assert.equal(progress.storeRestoreComplete, true)
	assert.equal(progress.d1ImportComplete, true)
	assert.equal(state.exportCalls, 2)
	const safetyExportKey = progress.safetyExportKey
	assert.equal(
		safetyExportKey,
		`pre-restore/${day}/${DATABASE_ID}/${day}T12:00:00.000Z.sql`,
	)
	assert.equal(progress.safetyExportBytes, safetySql.length)
	assert.ok(await bucket.head(safetyExportKey))
})

test('production restore refuses SQL with oversized statement stats', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, sqlObjectKey } = await seedSealedRestoreDay(
		bucket,
		'2026-07-31',
	)
	await bucket.put(
		`${sqlObjectKey}.stats.json`,
		JSON.stringify(badSqlStatsFixture(day, sqlObjectKey)),
	)

	let fetchCalls = 0
	await assert.rejects(
		runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async () => {
					fetchCalls += 1
					throw new Error('restore should not start')
				},
			},
		),
		backupError('backup-unrestorable-statements'),
	)
	assert.equal(fetchCalls, 0)
})

test('production restore of a historical single-database day completes the workflow without failure', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, preparedImportMd5, sqlObjectKey } =
		await seedSealedRestoreDay(bucket)
	configureJobsDatabase(env)
	const sqlAccess = trackSqlObjectAccess(bucket, [sqlObjectKey])
	const { state, fetcher } = restoreFetcher(preparedImportMd5, [])
	const progress = await runProductionRestore(
		env,
		{ day, requestedAt: `${day}T12:00:00.000Z` },
		restoreOptions(day, fetcher),
	)
	assert.equal(progress.phase, 'complete')
	assert.deepEqual(state.importedDatabaseIds, [DATABASE_ID])
	assert.equal(state.exportCalls, 2)
	assert.deepEqual(progress.warnings, [])
	assert.deepEqual(progress.notes, ['JOBS_DB: not present in this backup day'])
	assert.equal(restoreProgressFailsWorkflow(progress), false)
	assert.equal(progress.safetyExports?.length, 1)
	assert.equal(progress.safetyExports?.[0]?.databaseId, DATABASE_ID)
	assert.deepEqual(sqlAccess.heads, [sqlObjectKey])
	assert.deepEqual(sqlAccess.gets, [sqlObjectKey, sqlObjectKey, sqlObjectKey])
})

test('production restore verifies every required SQL object before importing APP_DB', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, sqlObjectKey, appManifestKey, appManifestSha256 } =
		await seedSealedRestoreDay(bucket)
	configureJobsDatabase(env)
	const jobs = await putJobsManifestWithoutSql(bucket, env, day)
	await putSealedFullManifest(bucket, env, day, {
		d1ManifestKey: appManifestKey,
		d1ManifestSha256: appManifestSha256,
		d1Sources: [
			{
				databaseId: DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
				manifestKey: appManifestKey,
				manifestSha256: appManifestSha256,
			},
			{
				databaseId: JOBS_DATABASE_ID,
				databaseName: 'kody-jobs',
				manifestKey: jobs.manifestKey,
				manifestSha256: sha256Text(jobs.storedText),
			},
		],
	})

	const sqlAccess = trackSqlObjectAccess(bucket, [
		sqlObjectKey,
		jobs.sqlObjectKey,
	])
	let fetchCalls = 0
	let importedAppDb = false
	await assert.rejects(
		runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async (input) => {
					fetchCalls += 1
					if (String(input).includes(`/d1/database/${DATABASE_ID}/import`)) {
						importedAppDb = true
					}
					throw new Error('restore should not start')
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'restore-sql-missing' &&
			error.message.includes(jobs.sqlObjectKey) &&
			error.message.includes('kody-jobs'),
	)
	assert.equal(fetchCalls, 0)
	assert.equal(importedAppDb, false)
	assert.deepEqual(sqlAccess.heads, [sqlObjectKey, jobs.sqlObjectKey])
	assert.deepEqual(sqlAccess.gets, [])
})

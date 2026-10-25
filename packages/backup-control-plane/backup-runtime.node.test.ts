import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { afterEach, test, vi } from 'vitest'

import { NonRetryableError } from 'cloudflare:workflows'
import { acceptUploadStepResult, runBackupRuntime } from './backup-runtime.ts'
import { DEFAULT_BACKUP_MAX_SOURCE_BYTES } from './d1-export-api.ts'
import { readManifest } from './immutable-storage.ts'
import {
	backupPayload,
	errorCode,
	objectKeyForBookmark,
	workflowInstanceId,
} from './backup-policy.ts'
import { type BackupEnvironment, type BackupPayload } from './backup-types.ts'
import {
	CachedUploadStep,
	DATABASE_ID,
	MemoryBucket,
	PreStatsUploadStep,
	RetryAfterCommitStep,
	RetryUploadStep,
	badSqlStatsFixture,
	environment,
	exportEnvelope,
	identityEnvelope,
	backupError,
} from './backup-control-plane-test-support.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

type RuntimeStep = Parameters<typeof runBackupRuntime>[2]
type RuntimeOptions = NonNullable<Parameters<typeof runBackupRuntime>[3]>

const okDownload = async () =>
	new Response('valid', { headers: { 'content-length': '5' } })

function completeApi(
	onExport: (init?: RequestInit) => Response = () => exportEnvelope('complete'),
) {
	return {
		fetcher: async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input).endsWith('/export')
				? onExport(init)
				: identityEnvelope(1_000),
		sleep: async () => undefined,
	}
}

const completeOptions = (): RuntimeOptions => ({
	api: completeApi(),
	downloadFetcher: okDownload,
})

function runDay(
	env: BackupEnvironment,
	payload: BackupPayload,
	step: RuntimeStep,
	options?: RuntimeOptions,
	rawPayload: unknown = payload,
) {
	return runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload: rawPayload,
			timestamp: new Date(Date.parse(payload.scheduledAt) + 1_000),
		},
		step,
		options,
	)
}

/**
 * Match production `ProductionD1BackupWorkflow`: convert non-retryable
 * BackupError to NonRetryableError inside the step, then reconstitute the
 * rejection the way Workflows RPC often does (`Error` + `NonRetryableError:`
 * message prefix) so recovery must parse that form via `errorCode()`.
 */
function productionLikeStep(inner: RuntimeStep): RuntimeStep {
	const bounded = withNonRetryableBackupErrors(inner)
	return {
		async do<T>(
			name: string,
			configOrCallback: unknown,
			callback?: () => Promise<T>,
		): Promise<T> {
			try {
				if (typeof configOrCallback === 'function') {
					return await bounded.do(name, configOrCallback as () => Promise<T>)
				}
				return await bounded.do(name, configOrCallback, callback!)
			} catch (error) {
				if (error instanceof NonRetryableError) {
					throw new Error(`NonRetryableError: ${error.message}`)
				}
				throw error
			}
		},
		sleep(name, duration) {
			return bounded.sleep(name, duration)
		},
	}
}

const julyPayload = (env: BackupEnvironment, day = '2026-07-22') =>
	backupPayload(env, new Date(`${day}T02:15:00Z`))

const consoleEvents = (spy: { mock: { calls: Array<Array<unknown>> } }) =>
	spy.mock.calls.map(([record]) => JSON.parse(String(record)).event as string)

test('source size gates block export for zero and oversize readings', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	let liveSize = 0
	let exportCalls = 0
	const options: RuntimeOptions = {
		api: {
			fetcher: async (input: RequestInfo | URL) => {
				if (!String(input).endsWith('/export')) {
					return identityEnvelope(liveSize)
				}
				exportCalls += 1
				return exportEnvelope('complete')
			},
			sleep: async () => undefined,
		},
		downloadFetcher: okDownload,
	}

	await assert.rejects(
		runDay(env, payload, new CachedUploadStep(() => undefined), options),
		backupError('source-size-zero', true),
	)
	assert.equal(exportCalls, 0)
	assert.equal(bucket.puts.length, 0)

	liveSize = 1_000
	const result = await runDay(
		env,
		payload,
		new CachedUploadStep(() => undefined),
		options,
	)
	assert.equal(result.payload.sql.bytes, 5)
	// One export start plus one upload-callback refresh; finalization never
	// polls D1 again.
	assert.equal(exportCalls, 2)

	consoleError.mockClear()
	const oversizeUrls: string[] = []
	await assert.rejects(
		runDay(env, payload, new RetryAfterCommitStep(), {
			api: {
				fetcher: async (input) => {
					oversizeUrls.push(String(input))
					return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
				},
			},
		}),
		backupError('source-size-limit-exceeded'),
	)
	assert.equal(oversizeUrls.length, 1)
	assert.equal(
		oversizeUrls.some((url) => url.endsWith('/export')),
		false,
	)
	assert.equal(consoleError.mock.calls.length, 2)
})

test('legacy scheduled payloads without kind resume; malformed legacy or scheduled payloads are rejected', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const current = julyPayload(env)
	const legacyPayload = {
		scheduledAt: current.scheduledAt,
		day: current.day,
		objectPrefix: current.objectPrefix,
		manifestKey: current.manifestKey,
		retentionTier: current.retentionTier,
	}
	const result = await runDay(
		env,
		current,
		new CachedUploadStep(() => undefined),
		completeOptions(),
		legacyPayload,
	)
	assert.equal(result.payload.export.scheduledAt, legacyPayload.scheduledAt)
	assert.equal(result.payload.sql.bytes, 5)
	assert.notEqual(await bucket.get(current.manifestKey), null)

	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const accessorPayload = { ...legacyPayload }
	Object.defineProperty(accessorPayload, 'scheduledAt', {
		enumerable: true,
		get: () => current.scheduledAt,
	})
	const symbolPayload = { ...legacyPayload }
	Object.defineProperty(symbolPayload, Symbol('extra'), {
		enumerable: true,
		value: 'extra',
	})
	const invalidPayloads = [
		{ ...legacyPayload, scheduledAt: undefined },
		{ ...legacyPayload, scheduledAt: null },
		{ ...legacyPayload, scheduledAt: 'not-a-date' },
		{ ...legacyPayload, scheduledAt: '2026-07-22' },
		{ ...legacyPayload, scheduledAt: '2026-07-22T02:15:00Z' },
		{ ...legacyPayload, scheduledAt: '2026-02-30T02:15:00.000Z' },
		{ ...legacyPayload, extra: true },
		Object.assign(Object.create({ inherited: true }), legacyPayload),
		Object.assign(Object.create(null), legacyPayload),
		accessorPayload,
		symbolPayload,
		// Scheduled discriminants require exact payload fields too.
		{ ...current, extra: true },
		Object.assign(Object.create({ inherited: true }), current),
	]
	for (const invalidPayload of invalidPayloads) {
		await assert.rejects(
			runDay(
				environment(),
				current,
				new CachedUploadStep(() => undefined),
				undefined,
				invalidPayload,
			),
			backupError('invalid-workflow-payload'),
		)
	}
	assert.equal(consoleError.mock.calls.length, 13)
})

test('workflow retry reuses an upload committed before step persistence and writes the absent manifest', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const step = new RetryAfterCommitStep()
	const apiCalls: string[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runDay(env, payload, step, {
		api: {
			fetcher: async (input) => {
				const url = String(input)
				apiCalls.push(url)
				if (!url.endsWith('/export')) return identityEnvelope(1_000)
				exportCalls += 1
				return exportEnvelope(
					'complete',
					'bookmark-1',
					`https://download.example/url-${exportCalls}`,
				)
			},
			sleep: async () => undefined,
		},
		downloadFetcher: async (input) => {
			downloadUrls.push(String(input))
			return okDownload()
		},
	})
	assert.deepEqual(step.uploadResults, [false, true])
	assert.deepEqual(downloadUrls, [
		'https://download.example/url-2',
		'https://download.example/url-3',
	])
	assert.equal(apiCalls.filter((url) => url.endsWith('/export')).length, 3)
	assert.equal(
		result.payload.sql.objectKey,
		objectKeyForBookmark(payload.objectPrefix, 'bookmark-1'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
	// Statement stats are persisted next to the SQL object.
	const statsObject = await bucket.get(
		`${result.payload.sql.objectKey}.stats.json`,
	)
	assert.notEqual(statsObject, null)
	const stats = JSON.parse(await statsObject!.text()) as {
		maxStatementBytes: number
		oversizedStatementCount: number
	}
	assert.equal(stats.oversizedStatementCount, 0)
	assert.ok(stats.maxStatementBytes > 0)
})

test('oversized SQL writes stats then fails retryably without a day manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env, '2026-07-31')
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const sql = `INSERT INTO t VALUES ('${'x'.repeat(100_001)}');`

	await assert.rejects(
		runDay(env, payload, new CachedUploadStep(() => undefined), {
			api: completeApi(),
			downloadFetcher: async () =>
				new Response(sql, {
					headers: { 'content-length': String(sql.length) },
				}),
		}),
		backupError('backup-unrestorable-statements', true),
	)

	const statsObject = await bucket.get(`${objectKey}.stats.json`)
	assert.notEqual(statsObject, null)
	const stats = (await statsObject!.json()) as {
		oversizedStatementCount: number
	}
	assert.equal(stats.oversizedStatementCount, 1)
	assert.equal(await bucket.head(payload.manifestKey), null)
	const events = consoleEvents(consoleError)
	assert.ok(events.includes('backup-unrestorable-statements'))
	assert.ok(events.includes('backup-failure'))
})

test('cached pre-stats uploads are allowed only for legacy backup days; conflicting stats block the manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)

	const legacyBucket = new MemoryBucket()
	const legacyEnv = environment(legacyBucket)
	const legacyPayload = julyPayload(legacyEnv, '2026-07-27')
	await runDay(
		legacyEnv,
		legacyPayload,
		new PreStatsUploadStep(),
		completeOptions(),
	)
	assert.notEqual(await legacyBucket.head(legacyPayload.manifestKey), null)
	assert.ok(consoleEvents(consoleLog).includes('backup-stats-legacy-missing'))

	const requiredBucket = new MemoryBucket()
	const requiredEnv = environment(requiredBucket)
	const requiredPayload = julyPayload(requiredEnv, '2026-07-28')
	await assert.rejects(
		runDay(
			requiredEnv,
			requiredPayload,
			new PreStatsUploadStep(),
			completeOptions(),
		),
		backupError('backup-sql-stats-missing', true),
	)
	assert.equal(await requiredBucket.head(requiredPayload.manifestKey), null)

	const conflictBucket = new MemoryBucket()
	const conflictEnv = environment(conflictBucket)
	const conflictPayload = julyPayload(conflictEnv, '2026-07-31')
	const objectKey = objectKeyForBookmark(
		conflictPayload.objectPrefix,
		'bookmark-1',
	)
	await assert.rejects(
		runDay(
			conflictEnv,
			conflictPayload,
			new CachedUploadStep(async () => {
				await conflictBucket.put(
					`${objectKey}.stats.json`,
					JSON.stringify(badSqlStatsFixture(conflictPayload.day, objectKey)),
				)
			}),
			completeOptions(),
		),
		backupError('backup-sql-stats-conflict'),
	)
	assert.equal(await conflictBucket.head(conflictPayload.manifestKey), null)
})

test('initial upload ignores a stale cached signed URL and refreshes it in the callback', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const exportBodies: unknown[] = []
	const downloadUrls: string[] = []
	const signedUrls = [
		'https://download.example/stale-initial',
		'https://download.example/fresh-upload',
		'https://download.example/fresh-finalization',
	]
	const result = await runDay(
		env,
		payload,
		new CachedUploadStep(() => undefined),
		{
			api: completeApi((init) => {
				exportBodies.push(JSON.parse(String(init?.body)))
				return exportEnvelope(
					'complete',
					'bookmark-1',
					signedUrls[exportBodies.length - 1],
				)
			}),
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url === 'https://download.example/stale-initial') {
					return new Response('', { status: 403 })
				}
				return okDownload()
			},
		},
	)
	assert.deepEqual(exportBodies, [
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
	])
	// The stale initial URL is never used and finalization performs no D1
	// download at all: it verifies the stored object against the durable
	// upload-step digest instead.
	assert.deepEqual(downloadUrls, ['https://download.example/fresh-upload'])
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('upload falls back to the poll-step signed URL when refresh finds the export lost', async () => {
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const exportBodies: unknown[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runDay(
		env,
		payload,
		new CachedUploadStep(() => undefined),
		{
			api: completeApi((init) => {
				exportCalls += 1
				exportBodies.push(JSON.parse(String(init?.body)))
				if (exportCalls === 1) {
					return exportEnvelope(
						'complete',
						'bookmark-1',
						'https://download.example/from-poll-step',
					)
				}
				return exportEnvelope('lost')
			}),
			downloadFetcher: async (input) => {
				downloadUrls.push(String(input))
				return okDownload()
			},
		},
	)
	assert.equal(result.payload.export.bookmark, 'bookmark-1')
	assert.deepEqual(exportBodies, [
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
	])
	assert.deepEqual(downloadUrls, ['https://download.example/from-poll-step'])
	assert.ok(
		consoleEvents(consoleLog).includes('backup-export-signed-url-fallback'),
	)
	assert.equal(
		consoleEvents(consoleLog).includes('backup-export-result-expired-recover'),
		false,
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('an expired export result recovers via durable step result (not NonRetryableError)', async () => {
	// Workflows treats NonRetryableError as instance-terminal. Recovery must
	// complete the upload step with `{ kind: 'export-result-expired' }` so the
	// runtime can start `recover-N-*` steps in the same instance.
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const exportBodies: unknown[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runDay(
		env,
		payload,
		productionLikeStep(new CachedUploadStep(() => undefined)),
		{
			api: completeApi((init) => {
				exportCalls += 1
				exportBodies.push(JSON.parse(String(init?.body)))
				// Attempt 1: start completes, upload refresh finds expired, and
				// the poll-step signed URL is also dead (403) → recover-2.
				// Attempt 2 (recover-2-* steps): start + refresh succeed.
				if (exportCalls === 1) {
					return exportEnvelope(
						'complete',
						'bookmark-1',
						'https://download.example/stale',
					)
				}
				if (exportCalls === 2) return exportEnvelope('lost')
				return exportEnvelope(
					'complete',
					'bookmark-2',
					'https://download.example/recovered',
				)
			}),
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url === 'https://download.example/stale') {
					return new Response('', { status: 403 })
				}
				return okDownload()
			},
		},
	)
	assert.equal(result.payload.export.bookmark, 'bookmark-2')
	assert.deepEqual(exportBodies, [
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-2' },
	])
	assert.deepEqual(downloadUrls, [
		'https://download.example/stale',
		'https://download.example/recovered',
	])
	assert.deepEqual(
		consoleEvents(consoleLog).filter((event) =>
			[
				'backup-export-signed-url-fallback',
				'backup-export-result-expired-recover',
				'backup-success',
			].includes(event),
		),
		[
			'backup-export-signed-url-fallback',
			'backup-export-result-expired-recover',
			'backup-success',
		],
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('acceptUploadStepResult keeps legacy flat StoredBackup and tagged results', () => {
	assert.deepEqual(acceptUploadStepResult({ kind: 'export-result-expired' }), {
		kind: 'export-result-expired',
	})
	assert.equal(
		acceptUploadStepResult({
			kind: 'stored',
			stored: {
				objectKey: 'daily/d1/x/2026-07-22/backup-b.sql',
				bookmark: 'bookmark-1',
				bytes: 5,
				sha256: 'abc',
				r2Etag: 'etag',
				alreadyExisted: false,
			},
		}).kind,
		'stored',
	)
	const legacy = acceptUploadStepResult({
		objectKey: 'daily/d1/x/2026-07-22/backup-b.sql',
		bookmark: 'bookmark-1',
		bytes: 5,
		sha256: 'abc',
		r2Etag: 'etag',
		alreadyExisted: true,
	})
	assert.equal(legacy.kind, 'stored')
	if (legacy.kind === 'stored') {
		assert.equal(legacy.stored.bookmark, 'bookmark-1')
		assert.equal(legacy.stored.alreadyExisted, true)
	}
	assert.equal(acceptUploadStepResult({ kind: 'stored' }).kind, 'unexpected')
	assert.equal(acceptUploadStepResult({ hello: 'world' }).kind, 'unexpected')
})

test('replayed pre-change flat upload result is accepted without recover export', async () => {
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const sqlBody = 'valid'
	await bucket.put(objectKey, sqlBody)
	const exportBodies: unknown[] = []
	const flatLegacyUpload = {
		objectKey,
		bookmark: 'bookmark-1',
		bytes: sqlBody.length,
		sha256: createHash('sha256').update(sqlBody).digest('hex'),
		r2Etag: createHash('md5').update(sqlBody).digest('hex'),
		alreadyExisted: true,
	}
	const step: RuntimeStep = {
		async do<T>(
			name: string,
			configOrCallback: unknown,
			callback?: () => Promise<T>,
		): Promise<T> {
			if (name === 'stream-export-to-immutable-r2') {
				return flatLegacyUpload as T
			}
			const execute =
				typeof configOrCallback === 'function'
					? (configOrCallback as () => Promise<T>)
					: callback
			if (!execute) {
				throw new Error('Workflow step callback is required.')
			}
			return await execute()
		},
		sleep: async () => undefined,
	}
	const result = await runDay(env, payload, step, {
		api: completeApi((init) => {
			exportBodies.push(JSON.parse(String(init?.body)))
			return exportEnvelope(
				'complete',
				'bookmark-1',
				'https://download.example/unused',
			)
		}),
		downloadFetcher: async () => {
			throw new Error('legacy replay must not re-download')
		},
	})
	assert.equal(result.payload.export.bookmark, 'bookmark-1')
	assert.equal(exportBodies.length, 1)
	assert.equal(
		consoleEvents(consoleLog).includes('backup-export-result-expired-recover'),
		false,
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('exhausted export-result-expired recovery fails without a manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const downloadUrls: string[] = []
	let exportCalls = 0
	await assert.rejects(
		runDay(
			env,
			payload,
			productionLikeStep(new CachedUploadStep(() => undefined)),
			{
				api: completeApi(() => {
					exportCalls += 1
					// Each attempt: start completes with a unique bookmark, refresh lost.
					if (exportCalls % 2 === 1) {
						return exportEnvelope('complete', `bookmark-${String(exportCalls)}`)
					}
					return exportEnvelope('lost')
				}),
				downloadFetcher: async (input) => {
					// Poll-step signed URLs are also dead, so fallback cannot save
					// the attempt and recover-N must run (then also fail).
					downloadUrls.push(String(input))
					return new Response('', { status: 403 })
				},
			},
		),
		(error: unknown) =>
			error instanceof Error && errorCode(error) === 'export-result-expired',
	)
	// Three start+refresh pairs (attempts 1..3).
	assert.equal(exportCalls, 6)
	assert.equal(downloadUrls.length, 3)
	assert.equal(await bucket.head(payload.manifestKey), null)
	assert.deepEqual(
		consoleEvents(consoleLog).filter(
			(event) => event === 'backup-export-result-expired-recover',
		),
		[
			'backup-export-result-expired-recover',
			'backup-export-result-expired-recover',
		],
	)
	assert.deepEqual(consoleEvents(consoleError), ['backup-failure'])
})

test('a replayed finalization tolerates the already-written manifest and stats', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const step = new CachedUploadStep(() => undefined)
	const first = await runDay(env, payload, step, completeOptions())
	// Replaying the same instance returns every cached step result without
	// re-executing uploads or manifest writes.
	const replay = await runDay(env, payload, step, completeOptions())
	assert.deepEqual(replay, first)

	// A *new* execution over an already-manifested day fails closed on the
	// immutable manifest instead of silently replacing it.
	await new Promise((resolve) => setTimeout(resolve, 2))
	await assert.rejects(
		runDay(
			env,
			payload,
			new CachedUploadStep(() => undefined),
			completeOptions(),
		),
		backupError('manifest-conflict'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		first,
	)
})

test('zero-byte upload retries with a fresh URL before manifest success', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	const step = new RetryUploadStep()
	let exportCalls = 0
	const downloadUrls: string[] = []
	const result = await runDay(env, payload, step, {
		api: completeApi(() => {
			exportCalls += 1
			return exportEnvelope(
				'complete',
				'bookmark-1',
				`https://download.example/export-${String(exportCalls)}`,
			)
		}),
		downloadFetcher: async (input) => {
			const url = String(input)
			downloadUrls.push(url)
			if (url.endsWith('export-2')) {
				return new Response('', { headers: { 'content-length': '0' } })
			}
			return okDownload()
		},
	})
	assert.deepEqual(step.uploadAttempts, [1, 2])
	assert.deepEqual(downloadUrls, [
		'https://download.example/export-2',
		'https://download.example/export-3',
	])
	assert.equal(result.payload.sql.bytes, 5)
	assert.equal(
		bucket.puts.filter(({ key }) => key === result.payload.sql.objectKey)
			.length,
		1,
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('tampered objects are rejected for retry and cached-upload paths without writing a manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)

	// Corruption surfaces at the layer that next touches the object: an
	// upload-step retry compares the existing object against the signed
	// source download, while a cached upload result is re-verified against
	// the durable step digest at finalization (no D1 download).
	for (const { createStep, expectedCode, expectedDownloads } of [
		{
			createStep: (corrupt: () => void) => new RetryAfterCommitStep(corrupt),
			expectedCode: 'existing-object-source-mismatch',
			expectedDownloads: 2,
		},
		{
			createStep: (corrupt: () => void) => new CachedUploadStep(corrupt),
			expectedCode: 'stored-object-mismatch',
			expectedDownloads: 1,
		},
	]) {
		consoleError.mockClear()
		const bucket = new MemoryBucket()
		const env = environment(bucket)
		const payload = julyPayload(env)
		const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
		const step = createStep(() => {
			bucket.corrupt(objectKey, 'evil!')
		})
		let downloadCalls = 0
		await assert.rejects(
			runDay(env, payload, step, {
				api: completeApi(),
				downloadFetcher: async () => {
					downloadCalls += 1
					return okDownload()
				},
			}),
			backupError(expectedCode, false),
		)
		assert.equal(downloadCalls, expectedDownloads)
		assert.equal(
			await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
			null,
		)
		assert.equal(consoleError.mock.calls.length, 1)
	}
})

test('source verification and manifest commit share one Workflow step boundary', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = julyPayload(env)
	let finalizationObserved = false
	const step = new CachedUploadStep(
		() => undefined,
		async () => {
			finalizationObserved = true
			assert.notEqual(
				await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
				null,
			)
		},
	)
	await runDay(env, payload, step, completeOptions())
	assert.equal(finalizationObserved, true)
})

test('manifest signing failure leaves committed SQL manifest-less and retry succeeds', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const validPrivateKey = env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64
	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 =
		Buffer.from('invalid-pkcs8').toString('base64')
	const payload = julyPayload(env)
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const step = new CachedUploadStep(() => undefined)
	await assert.rejects(
		runDay(env, payload, step, completeOptions()),
		backupError('manifest-signing-failed'),
	)
	assert.notEqual(await bucket.head(objectKey), null)
	assert.equal(await bucket.head(payload.manifestKey), null)

	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 = validPrivateKey
	await runDay(env, payload, step, completeOptions())
	assert.notEqual(await bucket.head(payload.manifestKey), null)
	assert.equal(consoleError.mock.calls.length, 1)
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import { expect, test, vi } from 'vitest'
import {
	backupStagingLegacySchemaVersion,
	backupStagingSchemaVersion,
	backupBlobKey,
	sealedFullManifestKey,
	sealedFullPrefix,
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
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	drExportMaxStorageDumpBufferBytes,
	__testOnlyCreateInitialProgress,
	__testOnlyParseProgress,
	runDrExportTick,
	runDrExportWatchdogTick,
	shouldRunDrExportCatchUpCron,
	shouldRunDrExportCron,
	shouldRunDrExportWatchdogCron,
} from '#worker/dr/exporter.ts'
import {
	listPlatformOwnerInventory,
	listPlatformStorageInventory,
} from '#worker/dr/exporter-inventory.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'

const storageMocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
}))

const mailboxMocks = vi.hoisted(() => ({
	exportMailbox: vi.fn(),
}))

const runLogMocks = vi.hoisted(() => ({
	exportRuns: vi.fn(),
}))

const storageBucketMocks = vi.hoisted(() => ({
	listPlatformStorageBuckets: vi.fn(
		async () => [] as Array<{ userId: string; storageId: string }>,
	),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		exportStorage: storageMocks.exportStorage,
	}),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		exportMailbox: mailboxMocks.exportMailbox,
	}),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	runLogRpc: () => ({
		exportRuns: runLogMocks.exportRuns,
	}),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listPlatformStorageBuckets: storageBucketMocks.listPlatformStorageBuckets,
	listUserStorageBucketIds: vi.fn(async () => []),
	registerStorageBucket: vi.fn(),
}))

const day = '2026-07-23'
const progressKey = `staging/${day}/exporter/progress.json`
const encode = (text: string) => new TextEncoder().encode(text)
const byteLength = (text: string) => encode(text).byteLength
const isStorageDump = (key: string) =>
	key.includes('/storage/') && key.endsWith('.ndjson')

function etagFor(bytes: Uint8Array) {
	let hash = 0
	for (const value of bytes) hash = (hash * 31 + value) >>> 0
	return `"${hash.toString(16)}"`
}

function createMemoryS3() {
	const objects = new Map<string, { bytes: Uint8Array; etag: string }>()
	const client: DrBackupS3Client = {
		async head(key) {
			const entry = objects.get(key)
			return entry
				? { exists: true, status: 200, etag: entry.etag }
				: { exists: false, status: 404, etag: null }
		},
		async getText(key) {
			const entry = objects.get(key)
			if (!entry) return null
			return {
				text: new TextDecoder().decode(entry.bytes),
				etag: entry.etag,
			}
		},
		async getBytes(key) {
			return objects.get(key)?.bytes ?? null
		},
		async put(key, body, options: DrBackupS3PutOptions = {}) {
			const existing = objects.get(key)
			if (options.ifNoneMatch === '*' && existing) {
				throw new DrBackupPreconditionFailedError(key)
			}
			if (options.ifMatch) {
				if (!existing || existing.etag !== options.ifMatch) {
					throw new DrBackupPreconditionFailedError(key)
				}
			}
			const bytes = typeof body === 'string' ? encode(body) : body
			const etag = etagFor(bytes)
			objects.set(key, { bytes, etag })
			return { etag }
		},
	}
	const readText = async (key: string) => (await client.getText(key))!.text
	const readNdjson = async <Row = Record<string, unknown>>(key: string) =>
		(await readText(key))
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Row)
	return { client, objects, readText, readNdjson }
}

/**
 * Fakes `Date.now` and burns 50s of tick budget after any put matching
 * `exhaustAfter`, so a run defers remaining work to the next tick.
 */
function useBudgetClock(
	client: DrBackupS3Client,
	exhaustAfter: (key: string, body: string | Uint8Array) => boolean,
) {
	const clock = { nowMs: 1_000_000 }
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs)
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		if (exhaustAfter(key, body)) clock.nowMs += 50_000
		return result
	}
	return {
		clock,
		originalPut,
		[Symbol.dispose]: () => dateNow.mockRestore(),
	}
}

function createDb(results: {
	users?: Array<{ ownerId: string }>
	jobs?: Array<{ userId: string; storageId: string }>
	artifacts?: Array<{
		sourceId: string
		userId: string
		entityKind: string
		entityId: string
		publishedCommit: string
	}>
}) {
	return {
		prepare(sql: string) {
			return {
				all: async () => {
					if (sql.includes('FROM users')) {
						return { results: results.users ?? [] }
					}
					if (sql.includes('FROM jobs')) {
						return { results: results.jobs ?? [] }
					}
					if (sql.includes('FROM entity_sources')) {
						return { results: results.artifacts ?? [] }
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

const r2Uploaded = new Date('2026-07-20T12:00:00.000Z')

/** Each argument is one `list()` page; cursors are `page-<n>`. */
function createR2(...pages: Array<Record<string, Uint8Array>>) {
	const all = Object.assign({}, ...pages) as Record<string, Uint8Array>
	return {
		async list(input?: { cursor?: string }) {
			const index = input?.cursor ? Number(input.cursor.slice(5)) - 1 : 0
			const truncated = index < pages.length - 1
			return {
				objects: Object.entries(pages[index] ?? {}).map(([key, value]) => ({
					key,
					size: value.byteLength,
					uploaded: r2Uploaded,
					etag: `etag-${key}`,
				})),
				truncated,
				cursor: truncated ? `page-${index + 2}` : '',
			}
		},
		async get(key: string) {
			const value = all[key]
			if (!value) return null
			return {
				arrayBuffer: async () =>
					value.buffer.slice(
						value.byteOffset,
						value.byteOffset + value.byteLength,
					),
			}
		},
	}
}

const s3Env = {
	DR_EXPORT_ENABLED: 'true',
	DR_BACKUP_ACCOUNT_ID: 'acct',
	DR_BACKUP_BUCKET_NAME: 'bucket',
	DR_BACKUP_ACCESS_KEY_ID: 'key',
	DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
}

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		...s3Env,
		APP_DB: createDb({}),
		EMAIL_BLOBS: createR2(),
		COMMUNITY_ASSETS: createR2(),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
		...overrides,
	} as unknown as Env
}

const twoJobsDb = () =>
	createDb({
		jobs: [
			{ userId: ownerIdFromStored('user-a'), storageId: 'job:1' },
			{ userId: ownerIdFromStored('user-a'), storageId: 'job:2' },
		],
	})

function mockStorageEntries(entries: Array<{ key: string; value: unknown }>) {
	storageMocks.exportStorage.mockResolvedValue({
		entries,
		truncated: false,
		nextStartAfter: null,
	})
}

function mockRunLogPage(page: Record<string, unknown> = {}) {
	runLogMocks.exportRuns.mockResolvedValue({
		runs: [],
		logs: [],
		packageInvocations: [],
		workflowProjections: [],
		jobRunObservability: [],
		packageRunSuccesses: [],
		activationMilestones: [],
		truncated: false,
		nextStartAfter: null,
		...page,
	})
}

const at = (time: string) => new Date(`${day}T${time}:00.000Z`)

test('exporter progresses phases with mocked bindings and S3, writing summary last', async () => {
	expect(
		['00:25', '00:30', '01:45', '06:10', '06:15'].map((t) =>
			shouldRunDrExportCron(at(t)),
		),
	).toEqual([false, true, true, true, false])
	expect(
		['06:10', '06:15', '06:20'].map((t) =>
			shouldRunDrExportWatchdogCron(at(t)),
		),
	).toEqual([false, true, false])
	// Catch-up cadence: never inside the nightly window; every 5-minute tick
	// outside it (aligned with the worker cron). 12:05 is on-boundary (runs);
	// 12:07 is off-boundary (skips).
	expect(
		['01:45', '12:00', '12:05', '12:07', '00:15'].map((t) =>
			shouldRunDrExportCatchUpCron(at(t)),
		),
	).toEqual([false, true, true, false, true])
	expect(
		await runDrExportTick({
			env: { DR_EXPORT_ENABLED: 'false' } as unknown as Env,
			now: at('01:00'),
		}),
	).toMatchObject({ skipped: true, reason: 'not-configured' })
	expect(
		await runDrExportTick({
			env: { DR_EXPORT_ENABLED: 'true' } as unknown as Env,
			now: at('00:26'),
		}),
	).toMatchObject({ skipped: true, reason: 'outside-nightly-window' })

	mockStorageEntries([{ key: 'alpha', value: { n: 1 } }])
	mailboxMocks.exportMailbox.mockResolvedValue({
		rows: [{ kind: 'thread', row: { id: 'thread-1' } }],
		truncated: false,
		nextStartAfter: null,
	})
	mockRunLogPage({
		runs: [{ id: 'excluded-run' }],
		logs: [{ id: 'excluded-log' }],
		packageInvocations: [{ id: 'excluded-invocation' }],
		workflowProjections: [{ id: 'excluded-projection' }],
		jobRunObservability: [{ jobId: 'job-1', runCount: 2 }],
		packageRunSuccesses: [{ packageId: 'pkg-1', successCount: 2 }],
		activationMilestones: [
			{
				milestone: 'package_activated',
				reachedAt: '2026-07-23T00:00:00.000Z',
				packageId: 'pkg-1',
			},
		],
	})
	const { client, objects, readText, readNdjson } = createMemoryS3()
	const blobBytes = encode('email-bytes')
	const blobKey = backupBlobKey(await sha256Hex(blobBytes))
	await client.put(blobKey, blobBytes)
	const headSpy = vi.spyOn(client, 'head')
	const putSpy = vi.spyOn(client, 'put')
	const kvSnapshot = JSON.stringify({ version: 1, files: { 'a.ts': 'x' } })
	const env = createEnv({
		APP_COMMIT_SHA: 'abcdef1',
		APP_DB: createDb({
			users: [{ ownerId: ownerIdFromStored('user-a') }],
			jobs: [{ userId: ownerIdFromStored('user-a'), storageId: 'job:1' }],
			artifacts: [
				{
					sourceId: 'src-1',
					userId: ownerIdFromStored('user-a'),
					entityKind: 'package',
					entityId: 'pkg-1',
					publishedCommit: 'commit-1',
				},
			],
		}),
		EMAIL_BLOBS: createR2({ 'raw/one': blobBytes }),
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) =>
				key === 'source-snapshot:v1:src-1:commit-1' ? kvSnapshot : null,
		},
	})

	const first = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(first).toMatchObject({
		skipped: false,
		summaryWritten: true,
		phase: 'done',
		mailboxDumpsCompleted: 1,
		runLogDumpsCompleted: 1,
	})
	expect(first.blobsReused).toBeGreaterThanOrEqual(1)

	const mailboxDumpKey = stagingMailboxDumpKey(day, 'user-a')
	const mailboxDump = await readText(mailboxDumpKey)
	expect(await readNdjson(mailboxDumpKey)).toEqual([
		{ kind: 'thread', row: { id: 'thread-1' } },
	])
	const mailboxIndex = JSON.parse(await readText(stagingMailboxIndexKey(day)))
	expect(mailboxIndex.entries).toEqual([
		{
			ownerId: ownerIdFromStored('user-a'),
			objectKey: mailboxDumpKey,
			entryCount: 1,
			bytes: byteLength(mailboxDump),
			sha256: await sha256Hex(mailboxDump),
		},
	])

	expect(runLogMocks.exportRuns).toHaveBeenCalledWith({
		pageSize: 250,
		startAfter: 'job-run-observability:',
	})
	const runLogDumpKey = stagingRunLogDumpKey(day, 'user-a')
	const runLogDump = await readText(runLogDumpKey)
	expect((await readNdjson(runLogDumpKey)).map((row) => row.kind)).toEqual([
		'jobRunObservability',
		'packageRunSuccess',
		'activationMilestone',
	])
	for (const excluded of [
		'excluded-run',
		'excluded-log',
		'excluded-invocation',
		'excluded-projection',
	]) {
		expect(runLogDump).not.toContain(excluded)
	}
	const runLogIndex = JSON.parse(await readText(stagingRunLogIndexKey(day)))
	expect(runLogIndex.entries).toEqual([
		{
			ownerId: ownerIdFromStored('user-a'),
			objectKey: runLogDumpKey,
			entryCount: 3,
			bytes: byteLength(runLogDump),
			sha256: await sha256Hex(runLogDump),
		},
	])

	const storageDumpKey = stagingStorageDumpKey(
		day,
		encodeStorageIdentity('user-a', 'job:1'),
	)
	expect(await readNdjson(storageDumpKey)).toEqual([
		{ key: 'alpha', valueJson: JSON.stringify({ n: 1 }) },
	])

	expect(await readText(stagingR2IndexKey(day, 'email-blobs'))).toContain(
		'raw/one',
	)
	expect(objects.has(blobKey)).toBe(true)
	expect(headSpy).toHaveBeenCalledWith(blobKey)
	expect(putSpy.mock.calls.filter(([key]) => key === blobKey)).toHaveLength(0)

	const summary = JSON.parse(await readText(stagingSummaryKey(day)))
	expect(summary.day).toBe(day)
	expect(summary.mailboxIndex).toEqual({
		objectKey: stagingMailboxIndexKey(day),
		bytes: byteLength(JSON.stringify(mailboxIndex)),
		sha256: await sha256Hex(JSON.stringify(mailboxIndex)),
	})
	expect(summary.runLogIndex).toEqual({
		objectKey: stagingRunLogIndexKey(day),
		bytes: byteLength(JSON.stringify(runLogIndex)),
		sha256: await sha256Hex(JSON.stringify(runLogIndex)),
	})
	expect(summary.storageIndex.sha256).toMatch(/^[0-9a-f]{64}$/)
	expect(summary.blobsWritten).toBeGreaterThanOrEqual(1)
	expect(summary.blobsReused).toBeGreaterThanOrEqual(1)
})

test('exporter resumes from progress cursor across ticks when budget is exhausted', async () => {
	mockStorageEntries([{ key: 'k', value: 1 }])
	const { client, objects, readText } = createMemoryS3()
	// After the first storage dump lands, exhaust the tick budget so the
	// second storage identity is deferred to the next cron tick.
	using budget = useBudgetClock(client, isStorageDump)
	const env = createEnv({ APP_DB: twoJobsDb() })

	const tick1 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(tick1).toMatchObject({
		timeBudgetExhausted: true,
		summaryWritten: false,
		storageDumpsCompleted: 1,
	})
	const progressAfterFirstTick = JSON.parse(await readText(progressKey))
	for (const inlined of [
		'storageEntries',
		'artifactEntries',
		'storagePartialNdjson',
		'r2PartialNdjson',
	]) {
		expect(progressAfterFirstTick).not.toHaveProperty(inlined)
	}
	expect(progressAfterFirstTick.storagePendingEntries).toHaveLength(1)

	budget.clock.nowMs = 1_000_000
	const tick2 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(tick2.summaryWritten).toBe(true)
	expect(storageMocks.exportStorage).toHaveBeenCalledTimes(2)
	expect(
		[...objects.keys()].some((key) =>
			key.startsWith(`staging/${day}/exporter/chunks/storage-index/`),
		),
	).toBe(true)
})

test('nightly ticks prefer the oldest stranded day before today', async () => {
	const { client } = createMemoryS3()
	const env = createEnv()
	const strandedDay = '2026-07-22'
	await client.put(
		`staging/${strandedDay}/exporter/progress.json`,
		JSON.stringify(__testOnlyCreateInitialProgress(strandedDay, at('02:00'))),
	)

	const resumed = await runDrExportTick({
		env,
		now: at('02:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(resumed).toMatchObject({
		day: strandedDay,
		mode: 'nightly',
		skipped: false,
	})
	expect(resumed.day).not.toBe(day)
	const todayProgress = await client.getText(progressKey)
	expect(todayProgress).not.toBeNull()
	expect(
		__testOnlyParseProgress(JSON.parse(todayProgress!.text)),
	).toMatchObject({
		day,
		phase: 'mailbox',
	})
	expect(await client.getText(stagingSummaryKey(day))).toBeNull()
})

test('nightly ticks target today when no stranded days exist', async () => {
	const { client } = createMemoryS3()
	const env = createEnv()
	const result = await runDrExportTick({
		env,
		now: at('02:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result).toMatchObject({
		day,
		mode: 'nightly',
	})
})

test('daytime catch-up resumes a stranded previous day until its summary is written', async () => {
	mockStorageEntries([{ key: 'k', value: 1 }])
	const { client, readText } = createMemoryS3()
	// Exhaust the tick budget after each storage dump so the night ends
	// with staged progress but no summary — a stranded day.
	using budget = useBudgetClock(client, isStorageDump)
	const env = createEnv({ APP_DB: twoJobsDb() })
	const tick = (now: string) =>
		runDrExportTick({
			env,
			now: new Date(now),
			timeBudgetMs: 60_000,
			s3: client,
		})

	const nightly = await runDrExportTick({
		env,
		now: at('06:10'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(nightly).toMatchObject({
		day,
		mode: 'nightly',
		timeBudgetExhausted: true,
		summaryWritten: false,
	})
	expect(await client.getText(stagingSummaryKey(day))).toBeNull()

	// Outside the window, ticks off the catch-up cadence stay cheap skips.
	budget.clock.nowMs = 1_000_000
	expect(await tick('2026-07-24T12:07:00.000Z')).toMatchObject({
		skipped: true,
		reason: 'outside-nightly-window',
	})

	// A cadence tick on the next day finds and finishes the stranded day.
	expect(await tick('2026-07-24T12:00:00.000Z')).toMatchObject({
		day,
		mode: 'catch-up',
		skipped: false,
		summaryWritten: true,
	})
	expect(JSON.parse(await readText(stagingSummaryKey(day))).day).toBe(day)

	// With the day complete, later cadence ticks exit cheaply.
	expect(await tick('2026-07-24T12:05:00.000Z')).toMatchObject({
		mode: 'catch-up',
		skipped: true,
		reason: 'no-stranded-day',
	})
})

test('catch-up prefers the oldest stranded day in the lookback', async () => {
	const { client } = createMemoryS3()
	const env = createEnv()
	const now = at('12:00')
	// One day just outside the 14-day lookback, plus three days inside it.
	const days = ['2026-07-08', '2026-07-21', '2026-07-22', '2026-07-23']
	for (const staged of days) {
		await client.put(
			`staging/${staged}/exporter/progress.json`,
			JSON.stringify(__testOnlyCreateInitialProgress(staged, now)),
		)
	}
	const sealedDays = async () => {
		const sealed: Array<string> = []
		for (const staged of days) {
			if (await client.getText(stagingSummaryKey(staged))) sealed.push(staged)
		}
		return sealed
	}

	for (const [time, expectedDay, sealed] of [
		['12:00', '2026-07-21', ['2026-07-21']],
		['12:05', '2026-07-22', ['2026-07-21', '2026-07-22']],
		['12:10', '2026-07-23', ['2026-07-21', '2026-07-22', '2026-07-23']],
	] as const) {
		expect(
			await runDrExportTick({
				env,
				now: at(time),
				timeBudgetMs: 60_000,
				s3: client,
			}),
		).toMatchObject({
			day: expectedDay,
			mode: 'catch-up',
			skipped: false,
			summaryWritten: true,
		})
		expect(await sealedDays()).toEqual(sealed)
	}
})

test('catch-up honors an active progress lease and resumes after it expires', async () => {
	mockStorageEntries([{ key: 'k', value: 1 }])
	const { client, readText } = createMemoryS3()
	using budget = useBudgetClock(client, isStorageDump)
	const env = createEnv({ APP_DB: twoJobsDb() })

	await runDrExportTick({
		env,
		now: at('06:10'),
		timeBudgetMs: 20_000,
		s3: client,
	})

	// Simulate another writer mid-tick: an unexpired lease on progress.
	const stored = JSON.parse(await readText(progressKey))
	stored.leaseId = 'another-writer'
	stored.leaseExpiresAt = new Date(budget.clock.nowMs + 60_000).toISOString()
	await budget.originalPut(progressKey, JSON.stringify(stored))

	budget.clock.nowMs = 1_000_000
	expect(
		await runDrExportTick({
			env,
			now: new Date('2026-07-24T12:00:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).toMatchObject({
		day,
		mode: 'catch-up',
		skipped: true,
		reason: 'progress-lease-active',
	})

	// Once the lease expires, catch-up takes over and finishes the day.
	budget.clock.nowMs = 2_000_000
	expect(
		await runDrExportTick({
			env,
			now: new Date('2026-07-24T12:15:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).toMatchObject({ day, mode: 'catch-up', summaryWritten: true })
})

test('operator day override resumes one specific stranded day and rejects invalid targets', async () => {
	mockStorageEntries([{ key: 'k', value: 1 }])
	const { client } = createMemoryS3()
	using budget = useBudgetClock(client, isStorageDump)
	const env = createEnv({ APP_DB: twoJobsDb() })
	// Any daytime minute: the operator override ignores window and cadence.
	const operatorTick = (target: string) =>
		runDrExportTick({
			env,
			day: target,
			now: new Date('2026-07-24T09:07:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		})

	await runDrExportTick({
		env,
		now: at('06:10'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	budget.clock.nowMs = 1_000_000

	await expect(operatorTick('not-a-day')).rejects.toThrow(/invalid backup day/)
	await expect(operatorTick('2026-07-25')).rejects.toThrow(/future/)
	// Resume-only: a day that never staged progress is not started fresh.
	expect(await operatorTick('2026-07-20')).toMatchObject({
		day: '2026-07-20',
		mode: 'operator',
		skipped: true,
		reason: 'no-staged-progress',
	})
	expect(await operatorTick(day)).toMatchObject({
		day,
		mode: 'operator',
		summaryWritten: true,
	})
	expect(await operatorTick(day)).toMatchObject({
		day,
		mode: 'operator',
		skipped: true,
		reason: 'already-complete',
	})
})

test('mailbox paging resumes without duplicate or missing rows', async () => {
	mailboxMocks.exportMailbox
		.mockResolvedValueOnce({
			rows: [
				{ kind: 'message', row: { id: 'message-a' } },
				{ kind: 'message', row: { id: 'message-b' } },
			],
			truncated: true,
			nextStartAfter: 'message:message-b',
		})
		.mockResolvedValueOnce({
			rows: [{ kind: 'message', row: { id: 'message-c' } }],
			truncated: false,
			nextStartAfter: null,
		})
	mockRunLogPage()
	const { client, readNdjson } = createMemoryS3()
	let exhausted = false
	using budget = useBudgetClock(client, (key, body) => {
		if (
			exhausted ||
			!key.endsWith('/exporter/progress.json') ||
			typeof body !== 'string' ||
			!body.includes('"pageStartAfter":"message:message-b"')
		) {
			return false
		}
		exhausted = true
		return true
	})
	const env = createEnv({
		APP_DB: createDb({
			users: [{ ownerId: ownerIdFromStored('user/with space') }],
		}),
		MAILBOX: {},
		RUN_LOG: {},
	})

	const tick1 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(tick1).toMatchObject({
		timeBudgetExhausted: true,
		mailboxDumpsCompleted: 0,
	})

	budget.clock.nowMs = 1_000_000
	const tick2 = await runDrExportTick({
		env,
		now: at('01:05'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(tick2.summaryWritten).toBe(true)
	expect(mailboxMocks.exportMailbox.mock.calls).toEqual([
		[{ pageSize: 250, startAfter: null }],
		[{ pageSize: 250, startAfter: 'message:message-b' }],
	])
	const rows = await readNdjson<{ row: { id: string } }>(
		stagingMailboxDumpKey(day, 'user/with space'),
	)
	expect(rows.map((line) => line.row.id)).toEqual([
		'message-a',
		'message-b',
		'message-c',
	])
})

test('empty mailbox owners share progress writes across a wave', async () => {
	const owners = Array.from({ length: 16 }, (_, index) =>
		ownerIdFromStored(`user-${String(index).padStart(2, '0')}`),
	)
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox.mockResolvedValue({
		rows: [],
		truncated: false,
		nextStartAfter: null,
	})
	mockRunLogPage()
	mockStorageEntries([])
	const { client, readText } = createMemoryS3()
	let progressPuts = 0
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		if (key.endsWith('/exporter/progress.json')) progressPuts += 1
		return originalPut(key, body, options)
	}
	const env = createEnv({
		APP_DB: createDb({
			users: owners.map((ownerId) => ({ ownerId })),
		}),
		MAILBOX: {},
		RUN_LOG: {},
	})

	const result = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	expect(result.mailboxDumpsCompleted).toBe(owners.length)
	expect(result.runLogDumpsCompleted).toBe(owners.length)
	expect(mailboxMocks.exportMailbox).toHaveBeenCalledTimes(owners.length)
	expect(runLogMocks.exportRuns).toHaveBeenCalledTimes(owners.length)
	// One persist per owner would be 32 lane writes plus lease and phase
	// transitions. Waves of 8 keep the whole tick well under that.
	expect(progressPuts).toBeLessThan(30)
	const mailboxIndex = JSON.parse(
		await readText(stagingMailboxIndexKey(day)),
	) as { entries: Array<{ ownerId: string; entryCount: number }> }
	expect(mailboxIndex.entries.map((entry) => entry.ownerId).sort()).toEqual(
		[...owners].sort(),
	)
	expect(mailboxIndex.entries.every((entry) => entry.entryCount === 0)).toBe(
		true,
	)
})

test('a failed owner read still keeps the successful pages from that wave', async () => {
	const owners = [ownerIdFromStored('user-a'), ownerIdFromStored('user-b')]
	let reads = 0
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox.mockImplementation(async () => {
		reads += 1
		if (reads === 2) throw new Error('mailbox down')
		return { rows: [], truncated: false, nextStartAfter: null }
	})
	mockRunLogPage()
	mockStorageEntries([])
	const { client, readText } = createMemoryS3()
	const env = createEnv({
		APP_DB: createDb({
			users: owners.map((ownerId) => ({ ownerId })),
		}),
		MAILBOX: {},
		RUN_LOG: {},
	})

	await expect(
		runDrExportTick({
			env,
			now: at('01:00'),
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).rejects.toThrow(/mailbox down/)
	const progress = JSON.parse(await readText(progressKey)) as {
		mailbox: { pendingEntries: Array<{ ownerId: string }> }
	}
	expect(progress.mailbox.pendingEntries.map((entry) => entry.ownerId)).toEqual(
		[owners[0]],
	)
	const leased = await client.getText(progressKey)
	const released = JSON.parse(leased!.text) as { leaseId: string | null }
	released.leaseId = null
	await client.put(
		progressKey,
		JSON.stringify({ ...released, leaseExpiresAt: null }),
		{
			ifMatch: leased!.etag ?? undefined,
		},
	)

	mailboxMocks.exportMailbox.mockResolvedValue({
		rows: [],
		truncated: false,
		nextStartAfter: null,
	})
	const resumed = await runDrExportTick({
		env,
		now: at('01:05'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(resumed.summaryWritten).toBe(true)
	expect(mailboxMocks.exportMailbox).toHaveBeenCalledTimes(3)
})

test('prefetched truncated mailbox pages are not read again in the same tick', async () => {
	const calls: Array<string | null> = []
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox.mockImplementation(
		async (input: { startAfter?: string | null }) => {
			const startAfter = input.startAfter ?? null
			calls.push(startAfter)
			if (startAfter === 'message:page-1') {
				return {
					rows: [{ kind: 'message', row: { id: 'page-2' } }],
					truncated: false,
					nextStartAfter: null,
				}
			}
			return {
				rows: [{ kind: 'message', row: { id: 'page-1' } }],
				truncated: true,
				nextStartAfter: 'message:page-1',
			}
		},
	)
	mockRunLogPage()
	mockStorageEntries([])
	const owners = [ownerIdFromStored('user-a'), ownerIdFromStored('user-b')]
	const { client, readNdjson } = createMemoryS3()
	const env = createEnv({
		APP_DB: createDb({
			users: owners.map((ownerId) => ({ ownerId })),
		}),
		MAILBOX: {},
		RUN_LOG: {},
	})

	const result = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	expect(calls).toEqual([null, null, 'message:page-1', 'message:page-1'])
	for (const ownerId of owners) {
		const rows = await readNdjson<{ row: { id: string } }>(
			stagingMailboxDumpKey(day, ownerId),
		)
		expect(rows.map((line) => line.row.id)).toEqual(['page-1', 'page-2'])
	}
})

test('an in-progress mailbox dump resumes before a newly inserted earlier owner', async () => {
	const calls: Array<string | null> = []
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox.mockImplementation(
		async (input: { startAfter?: string | null }) => {
			const startAfter = input.startAfter ?? null
			calls.push(startAfter)
			if (startAfter === 'message:page-1') {
				return {
					rows: [{ kind: 'message', row: { id: 'page-2' } }],
					truncated: false,
					nextStartAfter: null,
				}
			}
			return {
				rows: [{ kind: 'message', row: { id: 'page-1' } }],
				truncated: true,
				nextStartAfter: 'message:page-1',
			}
		},
	)
	mockRunLogPage()
	const users = [{ ownerId: ownerIdFromStored('user-b') }]
	const { client, readNdjson } = createMemoryS3()
	using budget = useBudgetClock(client, (key, body) => {
		return (
			typeof body === 'string' &&
			key.endsWith('/exporter/progress.json') &&
			body.includes('"pageStartAfter":"message:page-1"')
		)
	})
	const env = createEnv({
		APP_DB: createDb({ users }),
		MAILBOX: {},
		RUN_LOG: {},
	})

	const tick1 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(tick1).toMatchObject({
		timeBudgetExhausted: true,
		mailboxDumpsCompleted: 0,
	})

	users.unshift({ ownerId: ownerIdFromStored('user-a') })
	budget.clock.nowMs = 1_000_000
	const tick2 = await runDrExportTick({
		env,
		now: at('01:05'),
		timeBudgetMs: 200_000,
		s3: client,
	})
	expect(tick2.summaryWritten).toBe(true)
	expect(calls[0]).toBeNull()
	expect(calls[1]).toBe('message:page-1')
	const largeDump = await readNdjson<{ row: { id: string } }>(
		stagingMailboxDumpKey(day, ownerIdFromStored('user-b')),
	)
	expect(largeDump.map((line) => line.row.id)).toEqual(['page-1', 'page-2'])
})

test('inventory drift between ticks neither duplicates nor skips storage dumps', async () => {
	mockStorageEntries([{ key: 'k', value: 1 }])
	const { client, readText } = createMemoryS3()
	// Exhaust the budget after the first dump so the run resumes on the
	// next tick against a drifted inventory.
	using budget = useBudgetClock(client, isStorageDump)
	// Sorted inventory starts as [job:2, job:3]; tick 1 completes job:2.
	const jobs = [
		{ userId: ownerIdFromStored('user-a'), storageId: 'job:2' },
		{ userId: ownerIdFromStored('user-a'), storageId: 'job:3' },
	]
	const env = createEnv({ APP_DB: createDb({ jobs }) })

	const tick1 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(tick1.storageDumpsCompleted).toBe(1)

	// A job registers a new bucket mid-window that sorts BEFORE the
	// completed identity. A positional cursor would re-dump job:2
	// (duplicate index entry) and never dump job:1.
	jobs.unshift({ userId: ownerIdFromStored('user-a'), storageId: 'job:1' })

	budget.clock.nowMs = 1_000_000
	const tick2 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 200_000,
		s3: client,
	})
	expect(tick2.summaryWritten).toBe(true)

	const summary = JSON.parse(await readText(stagingSummaryKey(day)))
	const storageIndex = JSON.parse(
		await readText(summary.storageIndex.objectKey),
	) as { entries: Array<{ storageId: string }> }
	expect(storageIndex.entries.map((entry) => entry.storageId).sort()).toEqual([
		encodeStorageIdentity('user-a', 'job:1'),
		encodeStorageIdentity('user-a', 'job:2'),
		encodeStorageIdentity('user-a', 'job:3'),
	])
	expect(storageMocks.exportStorage).toHaveBeenCalledTimes(3)
})

test('exporter skips oversized storage dumps with a summary warning', async () => {
	const hugeValue = 'x'.repeat(drExportMaxStorageDumpBufferBytes + 1)
	storageMocks.exportStorage.mockImplementation(
		async (input: { startAfter?: string | null }) => ({
			entries: input.startAfter ? [] : [{ key: 'huge', value: hugeValue }],
			truncated: false,
			nextStartAfter: null,
		}),
	)
	const { client, readText } = createMemoryS3()
	const identity = encodeStorageIdentity('user-a', 'job:huge')
	const env = createEnv({
		APP_DB: createDb({
			jobs: [{ userId: ownerIdFromStored('user-a'), storageId: 'job:huge' }],
		}),
	})

	const result = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	expect(JSON.parse(await readText(stagingSummaryKey(day))).warnings).toContain(
		`storage dump too large: ${identity}`,
	)
	expect(await client.getText(stagingStorageDumpKey(day, identity))).toBeNull()
})

test('exporter aborts quietly when progress If-Match precondition fails', async () => {
	let storedValue = 1
	storageMocks.exportStorage.mockImplementation(async () => ({
		entries: [{ key: 'k', value: storedValue }],
		truncated: false,
		nextStartAfter: null,
	}))
	const { client, readNdjson } = createMemoryS3()
	const originalPut = client.put.bind(client)
	let storageDumpWritten = false
	let failedProgressAfterStorageDump = false
	client.put = async (key, body, options) => {
		if (isStorageDump(key)) storageDumpWritten = true
		if (
			key.includes('exporter/progress.json') &&
			storageDumpWritten &&
			!failedProgressAfterStorageDump
		) {
			failedProgressAfterStorageDump = true
			throw new DrBackupPreconditionFailedError(key)
		}
		return originalPut(key, body, options)
	}
	using budget = useBudgetClock(client, () => false)
	const env = createEnv({
		APP_DB: createDb({
			jobs: [{ userId: ownerIdFromStored('user-a'), storageId: 'job:1' }],
		}),
	})

	expect(
		await runDrExportTick({
			env,
			now: at('01:00'),
			timeBudgetMs: 60_000,
			s3: client,
		}),
	).toMatchObject({ skipped: true, reason: 'progress-precondition-failed' })

	// The failed tick wrote a complete immutable dump before losing
	// progress ownership. Once its lease expires, changed source bytes can
	// produce a new orphaned chunk while resume adopts the first complete
	// dump and finishes rather than conflicting forever.
	storedValue = 2
	budget.clock.nowMs += 3 * 60_000
	const resumed = await runDrExportTick({
		env,
		now: at('01:05'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(resumed.summaryWritten).toBe(true)
	const identity = encodeStorageIdentity('user-a', 'job:1')
	expect(await readNdjson(stagingStorageDumpKey(day, identity))).toEqual([
		expect.objectContaining({ valueJson: JSON.stringify(1) }),
	])
})

test('R2 export does not duplicate index lines across budget interruptions', async () => {
	const pagingR2 = createR2(
		{ a: encode('a'), b: encode('b') },
		{ c: encode('c') },
	)
	const listSpy = vi.spyOn(pagingR2, 'list')
	const { client, readNdjson } = createMemoryS3()
	let exhaustedAfterFirstPage = false
	// After the first R2 list page is persisted (cursor advanced), exhaust
	// the budget so the next tick resumes from page-2.
	using budget = useBudgetClock(client, (key, body) => {
		if (
			exhaustedAfterFirstPage ||
			!key.includes('exporter/progress.json') ||
			typeof body !== 'string' ||
			!body.includes('"r2ListCursor":"page-2"')
		) {
			return false
		}
		exhaustedAfterFirstPage = true
		return true
	})
	const env = createEnv({ EMAIL_BLOBS: pagingR2 })

	const tick1 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 20_000,
		s3: client,
	})
	expect(tick1).toMatchObject({
		timeBudgetExhausted: true,
		summaryWritten: false,
	})

	budget.clock.nowMs = 1_000_000
	const tick2 = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(tick2.summaryWritten).toBe(true)
	expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
	const index = await readNdjson<{ key: string }>(
		stagingR2IndexKey(day, 'email-blobs'),
	)
	expect(index.map((line) => line.key)).toEqual(['a', 'b', 'c'])
})

test('R2 export reuses unchanged objects from the latest sealed index', async () => {
	const unchangedBytes = encode('unchanged')
	const changedBytes = encode('changed-now')
	const unchangedDigest = await sha256Hex(unchangedBytes)
	const uploaded = r2Uploaded.toISOString()
	const previousIndexBody = [
		{
			key: 'unchanged',
			size: unchangedBytes.byteLength,
			sha256: unchangedDigest,
			etag: 'etag-unchanged',
			uploaded,
		},
		{
			key: 'changed',
			size: changedBytes.byteLength,
			sha256: await sha256Hex('changed-before'),
			etag: 'etag-before',
			uploaded,
		},
	]
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join('')
	const previousDay = '2026-07-22'
	const previousPrefix = sealedFullPrefix(previousDay)
	const previousIndexKey = `${previousPrefix}r2-index/email-blobs.ndjson`
	const file = (objectKey: string, sha: string) => ({
		objectKey,
		bytes: 0,
		sha256: sha.repeat(64),
	})
	const { client, readNdjson } = createMemoryS3()
	await client.put(previousIndexKey, previousIndexBody)
	await client.put(backupBlobKey(unchangedDigest), unchangedBytes)
	await client.put(
		sealedFullManifestKey(previousDay),
		JSON.stringify({
			schemaVersion: 1,
			payload: {
				schemaVersion: 1,
				day: previousDay,
				d1ManifestKey: `daily/d1/${previousDay}/manifest.json`,
				d1ManifestSha256: 'a'.repeat(64),
				storageIndex: file(`${previousPrefix}storage-index.json`, 'b'),
				r2Indexes: {
					'email-blobs': {
						objectKey: previousIndexKey,
						bytes: byteLength(previousIndexBody),
						sha256: await sha256Hex(previousIndexBody),
					},
				},
				artifactsIndex: file(`${previousPrefix}artifacts-index.json`, 'c'),
				sealedAt: '2026-07-22T06:30:00.000Z',
				buildCommit: 'abcdef1',
				signing: { algorithm: 'Ed25519', keyId: 'test-key' },
			},
			signature: {
				algorithm: 'Ed25519',
				keyId: 'test-key',
				value: 'test-signature',
			},
		}),
	)
	const emailBucket = createR2({
		unchanged: unchangedBytes,
		changed: changedBytes,
	})
	const get = vi.spyOn(emailBucket, 'get')
	const env = createEnv({ EMAIL_BLOBS: emailBucket })

	const result = await runDrExportTick({
		env,
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	expect(get).toHaveBeenCalledTimes(1)
	expect(get).toHaveBeenCalledWith('changed')
	expect(await readNdjson(stagingR2IndexKey(day, 'email-blobs'))).toEqual([
		expect.objectContaining({ key: 'unchanged', sha256: unchangedDigest }),
		expect.objectContaining({
			key: 'changed',
			sha256: await sha256Hex(changedBytes),
		}),
	])
})

test('DR inventory includes registry storage and excludes deleting owners', async () => {
	storageBucketMocks.listPlatformStorageBuckets.mockResolvedValueOnce([
		{ userId: ownerIdFromStored('user-a'), storageId: 'exec:adhoc-only' },
	])
	const inventoryDb = createDb({})
	const inventory = await listPlatformStorageInventory({
		db: inventoryDb,
		jobs: createD1JobsStore(inventoryDb),
	})
	expect(
		inventory.map(({ userId, storageId }) => ({ userId, storageId })),
	).toEqual([
		{ userId: ownerIdFromStored('user-a'), storageId: 'exec:adhoc-only' },
	])

	const prepare = vi.fn((sql: string) => ({
		all: async () => ({
			results: [{ ownerId: ownerIdFromStored('active-owner') }],
		}),
		sql,
	}))
	const owners = await listPlatformOwnerInventory({
		prepare,
	} as unknown as D1Database)
	expect(owners).toEqual(['active-owner'])
	expect(prepare).toHaveBeenCalledWith(
		expect.stringMatching(/FROM users\s+WHERE deleting_at IS NULL/),
	)
})

test('progress parsing rejects missing or malformed owner lanes', () => {
	const progress = __testOnlyCreateInitialProgress(day, at('00:30'))
	expect(__testOnlyParseProgress(progress)).toMatchObject({
		phase: 'mailbox',
	})
	expect(
		__testOnlyParseProgress({ ...progress, mailbox: undefined }),
	).toBeNull()
	expect(
		__testOnlyParseProgress({
			...progress,
			runLog: { ...progress.runLog, dumpChunkCount: -1 },
		}),
	).toBeNull()
})

test('a schema-v1 completion marker is conditionally upgraded after owner lanes finish', async () => {
	const { client, readText } = createMemoryS3()
	const file = (objectKey: string, sha: string) => ({
		objectKey,
		bytes: 0,
		sha256: sha.repeat(64),
	})
	await client.put(
		stagingSummaryKey(day),
		JSON.stringify({
			schemaVersion: backupStagingLegacySchemaVersion,
			day,
			startedAt: `${day}T00:30:00.000Z`,
			completedAt: `${day}T00:35:00.000Z`,
			buildCommit: 'legacy-build',
			storageIndex: file(stagingStorageIndexKey(day), 'a'),
			r2Indexes: {},
			artifactsIndex: file(stagingArtifactsIndexKey(day), 'b'),
			blobsWritten: 0,
			blobsReused: 0,
			warnings: [],
		}),
	)
	const legacy = await client.getText(stagingSummaryKey(day))
	const putSpy = vi.spyOn(client, 'put')

	const result = await runDrExportTick({
		env: createEnv(),
		now: at('01:00'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	const upgraded = JSON.parse(await readText(stagingSummaryKey(day)))
	expect(upgraded.schemaVersion).toBe(backupStagingSchemaVersion)
	expect(upgraded).toHaveProperty('mailboxIndex')
	expect(upgraded).toHaveProperty('runLogIndex')
	expect(putSpy).toHaveBeenCalledWith(
		stagingSummaryKey(day),
		expect.any(String),
		expect.objectContaining({ ifMatch: legacy!.etag }),
	)
})

test('watchdog passes on a written summary and fails loudly on incomplete or stranded nights', async () => {
	const env = s3Env as unknown as Env
	const now = at('06:15')
	const watchdog = (client: DrBackupS3Client) =>
		runDrExportWatchdogTick({ env, now, s3: client })

	expect(
		await runDrExportWatchdogTick({
			env: { DR_EXPORT_ENABLED: 'false' } as unknown as Env,
			now,
		}),
	).toMatchObject({ skipped: true, reason: 'not-configured' })

	// A previous day with neither progress nor summary (for example before DR
	// enablement) is not stranded.
	const complete = createMemoryS3()
	await complete.client.put(stagingSummaryKey(day), '{}')
	expect(await watchdog(complete.client)).toMatchObject({
		day,
		summaryPresent: true,
	})

	const incomplete = createMemoryS3()
	await incomplete.client.put(
		progressKey,
		JSON.stringify({
			...__testOnlyCreateInitialProgress(day, at('00:30')),
			phase: 'artifacts',
		}),
	)
	await expect(watchdog(incomplete.client)).rejects.toThrow(
		/summary missing for 2026-07-23.*phase=artifacts/,
	)

	// Backlog drain: tonight has no summary yet but an older day recently
	// advanced (lease cleared after a successful tick) — defer the page.
	const deferred = createMemoryS3()
	const activeOlder = {
		...__testOnlyCreateInitialProgress('2026-07-22', at('00:30')),
		leaseExpiresAt: null,
		advancedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
		revision: 12,
	}
	await deferred.client.put(
		'staging/2026-07-22/exporter/progress.json',
		JSON.stringify(activeOlder),
	)
	expect(await watchdog(deferred.client)).toMatchObject({
		day,
		skipped: false,
		summaryPresent: false,
		reason: 'deferred-for-older-stranded',
	})

	// Still advancing, but the oldest stranded day is two UTC days behind.
	// That pace loses to the calendar and must page even though a tick is moving.
	const lagging = createMemoryS3()
	await lagging.client.put(
		'staging/2026-07-21/exporter/progress.json',
		JSON.stringify({
			...__testOnlyCreateInitialProgress('2026-07-21', at('00:30')),
			leaseExpiresAt: null,
			advancedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
			revision: 20,
		}),
	)
	await expect(watchdog(lagging.client)).rejects.toThrow(
		/DR staging lag: oldest stranded day 2026-07-21 is 2 UTC days behind 2026-07-23/,
	)

	// Older stranded day with a cold advancedAt: page as catch-up stuck.
	const staleOlder = createMemoryS3()
	const staleProgress = {
		...__testOnlyCreateInitialProgress('2026-07-22', at('00:30')),
		leaseExpiresAt: null,
		advancedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
		revision: 3,
	}
	await staleOlder.client.put(
		'staging/2026-07-22/exporter/progress.json',
		JSON.stringify(staleProgress),
	)
	await expect(watchdog(staleOlder.client)).rejects.toThrow(
		/catch-up is stuck.*2026-07-22/,
	)

	// Tonight finished, but earlier days are still progress-without-summary.
	// The page lists oldest first — the same order catch-up resumes.
	const stranded = createMemoryS3()
	await stranded.client.put(stagingSummaryKey(day), '{}')
	await stranded.client.put(
		'staging/2026-07-22/exporter/progress.json',
		JSON.stringify(staleProgress),
	)
	await stranded.client.put(
		'staging/2026-07-21/exporter/progress.json',
		JSON.stringify({
			...staleProgress,
			day: '2026-07-21',
		}),
	)
	await expect(watchdog(stranded.client)).rejects.toThrow(
		/catch-up is stuck.*2026-07-21, 2026-07-22/,
	)
})

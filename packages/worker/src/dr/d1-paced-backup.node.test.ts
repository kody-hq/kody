import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as Sentry from '@sentry/cloudflare'
import { expect, test, vi } from 'vitest'
import {
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	pacedD1StagingDataKey,
	pacedD1StagingDataPartKey,
	pacedD1StagingIndexKey,
	pacedD1StagingIndexPartKey,
	pacedD1StagingManifestKey,
	pacedD1StagingProgressKey,
	parsePacedD1NightManifest,
	parsePacedD1ProgressCursor,
} from '@kody-internal/shared/backup-d1-paced.ts'
import { sha256HexOfText } from '@kody-internal/shared/backup-d1-paced-encode.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import {
	d1PacedBackupPartMaxBytes,
	d1PacedBackupRunTimeBudgetMs,
	d1PacedBackupTickByteBudget,
	parseD1PacedSources,
	resolvePacedD1Binding,
	runD1PacedBackupTick,
	runD1PacedBackupWatchdogTick,
	shouldRunD1PacedBackupCatchUpCron,
	shouldRunD1PacedBackupCron,
	shouldRunD1PacedBackupWatchdogCron,
	shouldRunD1PacedFreshnessCron,
	shouldRunD1PacedRestoreDrillCron,
} from '#worker/dr/d1-paced-backup.ts'
import {
	D1PacedBackupLeaseLostError,
	claimD1PacedBackupLease,
} from '#worker/dr/d1-paced-backup-lease.ts'
import { sealPacedD1SourceNight } from '#worker/dr/d1-paced-backup-seal.ts'
import {
	D1PacedRestoreDrillError,
	runD1PacedRestoreDrillTick,
} from '#worker/dr/d1-paced-restore-drill.ts'
import {
	ensureD1PacedRestoreDrillRun,
	readLatestD1PacedRestoreDrill,
	setD1PacedRestoreDrillSourceActive,
} from '#worker/dr/d1-paced-restore-drill-progress.ts'
import {
	collectD1PacedStatus,
	handleD1PacedForceFullBaseRequest,
} from '#worker/dr/d1-paced-status.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const day = '2026-10-24'
const appId = '8c1014d1-6b41-4695-a0a2-159071f0f919'
const jobsId = '5410331e-4d25-47e4-a1e5-a248f7cc764c'
const auditId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const encode = (text: string) => new TextEncoder().encode(text)

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
	return { client, objects }
}

function seedSqlite(rowCount = 3) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
		CREATE TABLE _rate_limits (
			key TEXT PRIMARY KEY NOT NULL,
			count INTEGER NOT NULL
		);
	`)
	for (let i = 1; i <= rowCount; i += 1) {
		sqlite
			.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`)
			.run(`i${i}`, `body-${i}`)
	}
	sqlite
		.prepare(`INSERT INTO _rate_limits (key, count) VALUES (?, ?)`)
		.run('x', 1)
	return sqlite
}

/** APP_DB holds the scheduled lane leases the paced backup tick claims. */
function createAppD1(sqlite: DatabaseSync) {
	sqlite.exec(`
		CREATE TABLE scheduled_lane_leases (
			lane TEXT PRIMARY KEY,
			holder TEXT NOT NULL,
			expires_at TEXT NOT NULL
		);
	`)
	return createD1FromSqlite(sqlite)
}

function sourcesJson(
	entries: Array<{ binding: string; name: string; id: string }>,
) {
	return JSON.stringify(entries)
}

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		DR_D1_PACED_BACKUP_ENABLED: 'true',
		DR_D1_PACED_RESTORE_DRILL_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		DR_D1_PACED_SOURCES: sourcesJson([
			{ binding: 'APP_DB', name: 'kody', id: appId },
		]),
		APP_DB: createAppD1(seedSqlite()),
		AUDIT_DB: createD1FromSqlite(seedSqlite(1)),
		...overrides,
	} as unknown as Env
}

const at = (time: string) => new Date(`${day}T${time}:00.000Z`)

const fastWalker = {
	minPage: 50,
	maxPage: 200,
	minGapMs: 0,
	sleep: async () => {},
}

test('paced backup cron windows match the DR export nightly window', () => {
	expect(
		['00:25', '00:30', '01:45', '06:10', '06:15'].map((t) =>
			shouldRunD1PacedBackupCron(at(t)),
		),
	).toEqual([false, true, true, true, false])
	expect(
		['06:10', '06:15', '06:20'].map((t) =>
			shouldRunD1PacedBackupWatchdogCron(at(t)),
		),
	).toEqual([false, true, false])
	expect(
		['01:45', '12:00', '12:05', '12:07'].map((t) =>
			shouldRunD1PacedBackupCatchUpCron(at(t)),
		),
	).toEqual([false, true, true, false])
	expect(shouldRunD1PacedFreshnessCron(at('12:45'))).toBe(true)
	expect(shouldRunD1PacedFreshnessCron(at('01:45'))).toBe(false)
	expect(
		shouldRunD1PacedRestoreDrillCron(new Date('2026-10-25T07:05:00.000Z')),
	).toBe(true) // Sunday
	expect(shouldRunD1PacedRestoreDrillCron(at('07:05'))).toBe(false) // Saturday
	expect(
		['06:55', '08:55', '09:00'].map((time) =>
			shouldRunD1PacedRestoreDrillCron(new Date(`2026-10-25T${time}:00.000Z`)),
		),
	).toEqual([false, true, false])
})

test('parseD1PacedSources requires UUID ids and known bindings', () => {
	expect(
		parseD1PacedSources(
			sourcesJson([
				{ binding: 'APP_DB', name: 'kody', id: appId },
				{ binding: 'JOBS_DB', name: 'kody-jobs', id: jobsId },
				{ binding: 'AUDIT_DB', name: 'kody-audit', id: auditId },
			]),
		),
	).toHaveLength(3)
	expect(() =>
		parseD1PacedSources(
			sourcesJson([{ binding: 'APP_DB', name: 'kody', id: 'not-a-uuid' }]),
		),
	).toThrow(/UUID/)
})

test('not configured skips without touching S3', async () => {
	const { client, objects } = createMemoryS3()
	const putSpy = vi.spyOn(client, 'put')
	expect(
		await runD1PacedBackupTick({
			env: { DR_D1_PACED_BACKUP_ENABLED: 'false' } as unknown as Env,
			now: at('01:00'),
			s3: client,
		}),
	).toMatchObject({ skipped: true, reason: 'not-configured' })
	expect(
		await runD1PacedBackupTick({
			env: {
				DR_D1_PACED_BACKUP_ENABLED: 'true',
				DR_BACKUP_ACCOUNT_ID: 'acct',
				DR_BACKUP_BUCKET_NAME: 'bucket',
				DR_BACKUP_ACCESS_KEY_ID: 'key',
				DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
				DR_D1_PACED_SOURCES: '',
			} as unknown as Env,
			now: at('01:00'),
			s3: client,
		}),
	).toMatchObject({ skipped: true, reason: 'sources-unset' })
	expect(putSpy).not.toHaveBeenCalled()
	expect(objects.size).toBe(0)
})

test('one full night writes a shadow staging manifest and seals it', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv()
	const result = await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(result).toMatchObject({
		skipped: false,
		manifestsWritten: 1,
		nightsSealed: 1,
		tablesCompleted: 2,
		day,
	})
	const raw = await client.getText(pacedD1StagingManifestKey(day, 'kody'))
	expect(raw).not.toBeNull()
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.shadow).toBe(true)
	expect(manifest.databaseId).toBe(appId)
	expect(Object.keys(manifest.tables)).toEqual([
		'items',
		'scheduled_lane_leases',
	])
	expect(manifest.tables.items?.mode).toBe('full')
	expect(manifest.tables.items?.count).toBe(3)
	// Finalize always leaves a parts pointer (never a monolithic TSV body).
	const stagingData = await client.getText(
		pacedD1StagingDataKey(day, 'kody', 'items'),
	)
	expect(stagingData).not.toBeNull()
	expect(JSON.parse(stagingData!.text)).toMatchObject({
		partCount: expect.any(Number),
		dataSha256: manifest.tables.items?.dataSha256,
	})
	expect(JSON.parse(stagingData!.text).partCount).toBeGreaterThan(0)
	const sealedKey = pacedD1SealedManifestKey(
		pacedD1RetentionTierForDay(day),
		appId,
		day,
	)
	expect(objects.has(sealedKey)).toBe(true)
	expect(
		objects.has(
			pacedD1SealedDataKey(
				pacedD1RetentionTierForDay(day),
				appId,
				day,
				'items',
			),
		),
	).toBe(true)
	const sealed = await client.getText(sealedKey)
	expect(
		parsePacedD1NightManifest(JSON.parse(sealed!.text)).tables.items?.count,
	).toBe(3)
	// Seal is immutable: a second seal attempt is idempotent.
	const again = await runD1PacedBackupTick({
		env,
		now: at('01:05'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(again).toMatchObject({ skipped: true, reason: 'already-complete' })
})

test('byte-capped part flush keeps buffer bounded and resumes after crash', async () => {
	const { client, objects } = createMemoryS3()
	// Wide rows so a few pages cross a tiny part cap.
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
	`)
	const body = 'x'.repeat(2000)
	for (let i = 1; i <= 40; i += 1) {
		sqlite
			.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`)
			.run(`i${i}`, body)
	}
	const env = createEnv({
		APP_DB: createAppD1(sqlite),
	})
	let peakBuffered = 0
	const partMaxBytes = 8_000
	const first = await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		partMaxBytes,
		tickByteBudget: 20_000,
		walkerOpts: {
			minPage: 2,
			maxPage: 2,
			minGapMs: 0,
			sleep: async () => {},
			onPage: () => {
				// Peak is observed indirectly via part files; track page calls.
				peakBuffered += 1
			},
		},
	})
	expect(first.timeBudgetExhausted).toBe(true)
	expect(first.manifestsWritten).toBe(0)
	const progressRaw = await client.getText(
		pacedD1StagingProgressKey(day, 'kody'),
	)
	expect(progressRaw).not.toBeNull()
	const progress = parsePacedD1ProgressCursor(JSON.parse(progressRaw!.text))
	expect(progress.currentTable).toBe('items')
	expect(progress.lastRowid).toBeTypeOf('number')
	expect(progress.partCount).toBeGreaterThan(1)
	expect(objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', 0))).toBe(
		true,
	)
	expect(objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', 1))).toBe(
		true,
	)
	// Each part must stay near the cap (single-page overshoot allowed).
	for (let i = 0; i < progress.partCount; i += 1) {
		const data = objects.get(pacedD1StagingDataPartKey(day, 'kody', 'items', i))
		const index = objects.get(
			pacedD1StagingIndexPartKey(day, 'kody', 'items', i),
		)
		expect(data).toBeTruthy()
		expect(index).toBeTruthy()
		const total = (data?.bytes.byteLength ?? 0) + (index?.bytes.byteLength ?? 0)
		expect(total).toBeLessThan(partMaxBytes * 3)
	}
	expect(peakBuffered).toBeGreaterThan(0)

	const savedRowid = progress.lastRowid
	const savedParts = progress.partCount

	// Simulate crash: drop in-memory state and resume from persisted cursor.
	const second = await runD1PacedBackupTick({
		env,
		now: at('01:05'),
		s3: client,
		partMaxBytes,
		walkerOpts: {
			minPage: 2,
			maxPage: 2,
			minGapMs: 0,
			sleep: async () => {},
		},
	})
	expect(second.manifestsWritten).toBe(1)
	const raw = await client.getText(pacedD1StagingManifestKey(day, 'kody'))
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.tables.items?.count).toBe(40)
	// Resume must have continued past the crashed cursor (more parts or done).
	expect(savedRowid).not.toBeNull()
	expect(savedParts).toBeGreaterThan(1)
})

test('full base past the old 8 MiB tick cap finishes in one tick with bounded parts', async () => {
	const { client, objects } = createMemoryS3()
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
	`)
	const rowCount = 1_200
	const body = 'x'.repeat(10_000)
	const insert = sqlite.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`)
	for (let i = 1; i <= rowCount; i += 1) insert.run(`i${i}`, body)
	expect(rowCount * body.length).toBeGreaterThan(8 * 1024 * 1024)
	expect(rowCount * body.length).toBeLessThan(d1PacedBackupTickByteBudget)

	const result = await runD1PacedBackupTick({
		env: createEnv({ APP_DB: createAppD1(sqlite) }),
		now: at('01:00'),
		s3: client,
		walkerOpts: { minGapMs: 0, sleep: async () => {} },
	})
	expect(result.manifestsWritten).toBe(1)
	const raw = await client.getText(pacedD1StagingManifestKey(day, 'kody'))
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.tables.items?.count).toBe(rowCount)

	let parts = 0
	for (; objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', parts));)
		parts += 1
	expect(parts).toBeGreaterThan(2)
	// Heap per tick is one part buffer plus at most one D1 page of overshoot.
	for (let i = 0; i < parts; i += 1) {
		const data = objects.get(pacedD1StagingDataPartKey(day, 'kody', 'items', i))
		const index = objects.get(
			pacedD1StagingIndexPartKey(day, 'kody', 'items', i),
		)
		const total = (data?.bytes.byteLength ?? 0) + (index?.bytes.byteLength ?? 0)
		expect(total).toBeLessThan(d1PacedBackupPartMaxBytes + 2 * 1024 * 1024)
	}
})

test('resume mid-table continues from lastRowid across ticks', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv({
		APP_DB: createAppD1(seedSqlite(6)),
	})
	let nowMs = 0
	const first = await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		timeBudgetMs: 50,
		walkerOpts: {
			minPage: 1,
			maxPage: 1,
			minGapMs: 0,
			sleep: async () => {
				nowMs = 100
			},
			now: () => nowMs,
		},
	})
	expect(first.timeBudgetExhausted).toBe(true)
	expect(first.manifestsWritten).toBe(0)
	const progressRaw = await client.getText(
		pacedD1StagingProgressKey(day, 'kody'),
	)
	expect(progressRaw).not.toBeNull()
	const progress = parsePacedD1ProgressCursor(JSON.parse(progressRaw!.text))
	expect(progress.currentTable).toBe('items')
	expect(progress.lastRowid).toBeTypeOf('number')
	expect(progress.partialCount).toBeGreaterThan(0)
	expect(progress.partCount).toBeGreaterThan(0)
	expect(objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', 0))).toBe(
		true,
	)
	// Mid-table resume must not rewrite a monolithic data TSV yet.
	expect(objects.has(pacedD1StagingDataKey(day, 'kody', 'items'))).toBe(false)

	const second = await runD1PacedBackupTick({
		env,
		now: at('01:05'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(second.manifestsWritten).toBe(1)
	const raw = await client.getText(pacedD1StagingManifestKey(day, 'kody'))
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.tables.items?.count).toBe(6)
	const finalized = await client.getText(
		pacedD1StagingDataKey(day, 'kody', 'items'),
	)
	expect(finalized).not.toBeNull()
	expect(JSON.parse(finalized!.text).partCount).toBeGreaterThan(0)
})

test('seal time budget can leave a night unsealed across ticks', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv()
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	const tier = pacedD1RetentionTierForDay(day)
	const sealedKey = pacedD1SealedManifestKey(tier, appId, day)
	const itemsDataKey = pacedD1SealedDataKey(tier, appId, day, 'items')
	const itemsIndexKey = pacedD1SealedIndexKey(tier, appId, day, 'items')
	expect(objects.has(sealedKey)).toBe(true)
	// Drop tip keys too — otherwise resume skips the table and writes the
	// sealed manifest even under a zero budget.
	objects.delete(sealedKey)
	objects.delete(itemsDataKey)
	objects.delete(itemsIndexKey)
	// Exhaust the budget before any table copy so seal returns incomplete.
	const stalled = await runD1PacedBackupTick({
		env,
		now: at('12:00'),
		s3: client,
		timeBudgetMs: 0,
		walkerOpts: fastWalker,
	})
	expect(stalled.skipped).toBe(false)
	expect(stalled.nightsSealed).toBe(0)
	expect(objects.has(sealedKey)).toBe(false)
	const finished = await runD1PacedBackupTick({
		env,
		now: at('12:05'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(finished.nightsSealed).toBeGreaterThanOrEqual(1)
	expect(objects.has(sealedKey)).toBe(true)
})

test('seal resume skips already-sealed tables instead of re-verifying them', async () => {
	const { client, objects } = createMemoryS3()
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
		CREATE TABLE notes (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
		CREATE TABLE _rate_limits (
			key TEXT PRIMARY KEY NOT NULL,
			count INTEGER NOT NULL
		);
	`)
	sqlite.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`).run('i1', 'a')
	sqlite.prepare(`INSERT INTO notes (id, body) VALUES (?, ?)`).run('n1', 'b')
	sqlite
		.prepare(`INSERT INTO _rate_limits (key, count) VALUES (?, ?)`)
		.run('x', 1)
	const env = createEnv({
		APP_DB: createAppD1(sqlite),
	})
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	const tier = pacedD1RetentionTierForDay(day)
	const sealedManifestKey = pacedD1SealedManifestKey(tier, appId, day)
	const itemsDataKey = pacedD1SealedDataKey(tier, appId, day, 'items')
	const itemsIndexKey = pacedD1SealedIndexKey(tier, appId, day, 'items')
	const notesDataKey = pacedD1SealedDataKey(tier, appId, day, 'notes')
	const notesIndexKey = pacedD1SealedIndexKey(tier, appId, day, 'notes')
	expect(objects.has(sealedManifestKey)).toBe(true)
	expect(objects.has(itemsDataKey)).toBe(true)
	expect(objects.has(notesDataKey)).toBe(true)

	// Simulate a mid-night seal: tip keys for items remain; notes + night
	// manifest still need work on the next tick.
	objects.delete(sealedManifestKey)
	objects.delete(notesDataKey)
	objects.delete(notesIndexKey)

	const putKeys: Array<string> = []
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		putKeys.push(key)
		return originalPut(key, body, options)
	}

	const source = {
		binding: 'APP_DB' as const,
		name: 'kody',
		id: appId,
	}
	const stalled = await sealPacedD1SourceNight({
		s3: client,
		source,
		day,
		timeBudgetMs: 0,
	})
	expect(stalled).toMatchObject({
		complete: false,
		tablesSealed: 1,
	})
	expect(objects.has(sealedManifestKey)).toBe(false)
	expect(putKeys).toEqual([])

	putKeys.length = 0
	const finished = await sealPacedD1SourceNight({
		s3: client,
		source,
		day,
	})
	expect(finished).toMatchObject({
		complete: true,
		tablesSealed: 3,
	})
	expect(objects.has(notesDataKey)).toBe(true)
	expect(objects.has(notesIndexKey)).toBe(true)
	expect(objects.has(sealedManifestKey)).toBe(true)
	// Already-sealed items tips must not be re-put (412 + full compare).
	expect(putKeys).not.toContain(itemsDataKey)
	expect(putKeys).not.toContain(itemsIndexKey)
	expect(putKeys).toContain(notesDataKey)
	expect(putKeys).toContain(sealedManifestKey)
})

test('catch-up seeds today after finishing a stranded older night', async () => {
	const { client } = createMemoryS3()
	const olderDay = '2026-10-23'
	const env = createEnv({
		APP_DB: createAppD1(seedSqlite(4)),
	})
	let nowMs = 0
	const stranded = await runD1PacedBackupTick({
		env,
		now: new Date(`${olderDay}T01:00:00.000Z`),
		s3: client,
		timeBudgetMs: 50,
		walkerOpts: {
			minPage: 1,
			maxPage: 1,
			minGapMs: 0,
			sleep: async () => {
				nowMs = 100
			},
			now: () => nowMs,
		},
	})
	expect(stranded.timeBudgetExhausted).toBe(true)
	expect(stranded.day).toBe(olderDay)

	const finishOlder = await runD1PacedBackupTick({
		env,
		now: at('12:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(finishOlder.day).toBe(olderDay)
	expect(finishOlder.manifestsWritten).toBe(1)

	const startToday = await runD1PacedBackupTick({
		env,
		now: at('12:05'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(startToday.skipped).toBe(false)
	expect(startToday.day).toBe(day)
	expect(startToday.manifestsWritten).toBe(1)
	expect(
		await client.head(pacedD1StagingManifestKey(day, 'kody')),
	).toMatchObject({ exists: true })
})

test('delta night reuses previous staging manifest and index', async () => {
	const { client } = createMemoryS3()
	const sqlite = seedSqlite(2)
	const env = createEnv({ APP_DB: createAppD1(sqlite) })
	const baseDay = '2026-10-23' // Friday
	const nextDay = '2026-10-24' // Saturday — daily / delta (Sunday forces full)
	await runD1PacedBackupTick({
		env,
		now: new Date(`${baseDay}T01:00:00.000Z`),
		s3: client,
		walkerOpts: fastWalker,
	})

	sqlite.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`).run('i3', 'new')
	sqlite.prepare(`DELETE FROM items WHERE id = ?`).run('i1')

	const delta = await runD1PacedBackupTick({
		env,
		now: new Date(`${nextDay}T01:00:00.000Z`),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(delta.manifestsWritten).toBe(1)
	const raw = await client.getText(pacedD1StagingManifestKey(nextDay, 'kody'))
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.prevDay).toBe(baseDay)
	expect(manifest.tables.items?.mode).toBe('delta')
	expect(manifest.tables.items?.count).toBe(2)
	expect(
		(manifest.tables.items?.upserts ?? 0) +
			(manifest.tables.items?.deletes ?? 0),
	).toBeGreaterThan(0)
})

test('missing JOBS_DB binding is skipped without failing the tick', async () => {
	const { client } = createMemoryS3()
	const env = createEnv({
		DR_D1_PACED_SOURCES: sourcesJson([
			{ binding: 'APP_DB', name: 'kody', id: appId },
			{ binding: 'JOBS_DB', name: 'kody-jobs', id: jobsId },
			{ binding: 'AUDIT_DB', name: 'kody-audit', id: auditId },
		]),
		// JOBS_DB intentionally omitted
	})
	expect(resolvePacedD1Binding(env, 'JOBS_DB')).toBeNull()
	const result = await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(result.skipped).toBe(false)
	expect(result.bindingsMissing).toBeGreaterThanOrEqual(1)
	expect(result.manifestsWritten).toBe(2)
	expect(result.nightsSealed).toBe(2)
	expect(
		await client.head(pacedD1StagingManifestKey(day, 'kody')),
	).toMatchObject({ exists: true })
	expect(
		await client.head(pacedD1StagingManifestKey(day, 'kody-audit')),
	).toMatchObject({ exists: true })
	expect(
		await client.head(pacedD1StagingManifestKey(day, 'kody-jobs')),
	).toMatchObject({ exists: false })
})

test('watchdog passes on the first sealed night without yesterday', async () => {
	const { client } = createMemoryS3()
	const env = createEnv()
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	await expect(
		runD1PacedBackupWatchdogTick({ env, now: at('06:15'), s3: client }),
	).resolves.toMatchObject({
		skipped: true,
		incompleteSources: 0,
		missingSealedSources: 0,
	})
})

test('catch-up reseals a day that has staging but no sealed manifest', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv()
	const olderDay = '2026-10-23'
	await runD1PacedBackupTick({
		env,
		now: new Date(`${olderDay}T01:00:00.000Z`),
		s3: client,
		walkerOpts: fastWalker,
	})
	const sealedKey = pacedD1SealedManifestKey('daily', appId, olderDay)
	expect(objects.has(sealedKey)).toBe(true)
	objects.delete(sealedKey)
	const catchUp = await runD1PacedBackupTick({
		env,
		now: at('12:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	expect(catchUp.day).toBe(olderDay)
	expect(catchUp.nightsSealed).toBeGreaterThanOrEqual(1)
	expect(objects.has(sealedKey)).toBe(true)
})

function applyDrillProgressMigration(sqlite: DatabaseSync) {
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0237-dr-paced-restore-drill-progress.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
}

/** APP + AUDIT sources sealed for `day`, with drill progress tables in APP_DB. */
async function sealTwoSourcesForDrill() {
	const { client } = createMemoryS3()
	const appSqlite = seedSqlite()
	const env = createEnv({
		APP_DB: createAppD1(appSqlite),
		DR_D1_PACED_SOURCES: sourcesJson([
			{ binding: 'APP_DB', name: 'kody', id: appId },
			{ binding: 'AUDIT_DB', name: 'kody-audit', id: auditId },
		]),
	})
	for (const time of ['01:00', '01:05', '01:10', '01:15']) {
		await runD1PacedBackupTick({
			env,
			now: at(time),
			s3: client,
			walkerOpts: fastWalker,
		})
	}
	const tier = pacedD1RetentionTierForDay(day)
	for (const id of [appId, auditId]) {
		expect(
			await client.head(pacedD1SealedManifestKey(tier, id, day)),
		).toMatchObject({
			exists: true,
		})
	}
	applyDrillProgressMigration(appSqlite)
	return { client, env, appSqlite }
}

const sundayAt = (time: string) => new Date(`2026-10-25T${time}:00.000Z`)

test('restore drill verifies sealed night against live counts', async () => {
	const { client } = createMemoryS3()
	const appSqlite = seedSqlite()
	const env = createEnv({ APP_DB: createAppD1(appSqlite) })
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	applyDrillProgressMigration(appSqlite)
	const drill = await runD1PacedRestoreDrillTick({
		env,
		now: new Date('2026-10-25T07:05:00.000Z'),
		s3: client,
		day,
	})
	expect(drill).toMatchObject({
		skipped: false,
		complete: true,
		sourcesChecked: 1,
		sourcesOk: 1,
	})
	expect(drill.reportKey).toBe(
		`staging/${day}/d1-paced/restore-drill-report.json`,
	)
	expect(drill.sources[0]?.tables[0]).toMatchObject({
		table: 'items',
		manifestCount: 3,
		restoredCount: 3,
		liveCount: 3,
		ok: true,
	})
	const report = await client.getText(drill.reportKey!)
	expect(report?.text).toContain('"kind": "paced-d1-restore-drill-report"')
	expect(report?.text).toContain('"sourcesOk": 1')
})

test('restore drill drills one source per tick and resumes from APP_DB progress', async () => {
	const { client, env } = await sealTwoSourcesForDrill()
	const first = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('07:00'),
		s3: client,
	})
	expect(first).toMatchObject({
		day,
		complete: false,
		reason: 'in-progress',
		sourcesChecked: 2,
		sourcesOk: 1,
	})
	expect(first.sources.map((source) => source.databaseName)).toEqual(['kody'])
	expect(
		await client.head(`staging/${day}/d1-paced/restore-drill-report.json`),
	).toMatchObject({ exists: false })

	const status = await collectD1PacedStatus({ env, s3: client, day })
	expect(status.restoreDrill?.run).toMatchObject({ day, status: 'running' })
	expect(
		status.restoreDrill?.sources.map((source) => [
			source.databaseName,
			source.status,
		]),
	).toEqual(
		expect.arrayContaining([
			['kody', 'passed'],
			['kody-audit', 'pending'],
		]),
	)

	const second = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('07:05'),
		s3: client,
	})
	expect(second).toMatchObject({
		complete: true,
		sourcesChecked: 2,
		sourcesOk: 2,
		reportKey: `staging/${day}/d1-paced/restore-drill-report.json`,
	})
	const progress = await readLatestD1PacedRestoreDrill(env.APP_DB)
	expect(progress?.run).toMatchObject({
		day,
		status: 'passed',
		sourcesOk: 2,
		sourcesTotal: 2,
	})
	expect(progress?.sources.every((source) => source.tables.length > 0)).toBe(
		true,
	)

	const getBytesSpy = vi.spyOn(client, 'getBytes')
	const third = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('07:10'),
		s3: client,
	})
	expect(third).toMatchObject({ skipped: true, reason: 'already-finished' })
	expect(getBytesSpy).not.toHaveBeenCalled()
})

test('restore drill reports a tick that died mid-phase with source and phase, then fails the table on a repeat', async () => {
	const { client, env, appSqlite } = await sealTwoSourcesForDrill()
	const captureMessage = vi.spyOn(Sentry, 'captureMessage')
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	await ensureD1PacedRestoreDrillRun(env.APP_DB, {
		day,
		sources: [
			{ id: appId, name: 'kody' },
			{ id: auditId, name: 'kody-audit' },
		],
		nowIso: sundayAt('07:00').toISOString(),
	})
	// Simulate an isolate that OOMed in the base pass of `items` (marker left
	// behind, lease expired).
	await setD1PacedRestoreDrillSourceActive(env.APP_DB, {
		day,
		databaseId: appId,
		table: 'items',
		phase: 'base',
		nowIso: sundayAt('07:00').toISOString(),
	})
	// An earlier death on a different table does not use up this table's retry.
	appSqlite
		.prepare(
			`UPDATE dr_paced_restore_drill_sources SET interrupted_count = 1, last_interrupted_table = 'earlier_table' WHERE database_id = ?`,
		)
		.run(appId)
	const resumed = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('07:05'),
		s3: client,
	})
	expect(captureMessage).toHaveBeenCalledWith(
		'paced D1 restore drill interrupted: kody base items',
		'fatal',
	)
	// First interruption retries the table, so the source still passes.
	expect(resumed.sources[0]).toMatchObject({ databaseName: 'kody', ok: true })

	await setD1PacedRestoreDrillSourceActive(env.APP_DB, {
		day,
		databaseId: auditId,
		table: 'items',
		phase: 'deltas',
		nowIso: sundayAt('07:05').toISOString(),
	})
	appSqlite
		.prepare(
			`UPDATE dr_paced_restore_drill_sources SET interrupted_count = 1, last_interrupted_table = 'items' WHERE database_id = ?`,
		)
		.run(auditId)
	const failure = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('07:10'),
		s3: client,
	}).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(D1PacedRestoreDrillError)
	expect(failure).toMatchObject({
		kind: 'mismatch',
		checkpoint: { day, source: 'kody-audit', table: 'items', phase: 'verify' },
	})
	const progress = await readLatestD1PacedRestoreDrill(env.APP_DB)
	const audit = progress?.sources.find(
		(source) => source.databaseName === 'kody-audit',
	)
	expect(audit).toMatchObject({ status: 'failed', interruptedCount: 2 })
	expect(audit?.tables.find((table) => table.table === 'items')).toMatchObject({
		ok: false,
		error: 'interrupted-deltas',
	})
	expect(progress?.run.status).toBe('failed')
	captureMessage.mockRestore()
	consoleError.mockRestore()
})

test('restore drill fails unfinished sources once the Sunday window deadline passes', async () => {
	const { client, env } = await sealTwoSourcesForDrill()
	const failure = await runD1PacedRestoreDrillTick({
		env,
		now: sundayAt('08:50'),
		s3: client,
	}).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(D1PacedRestoreDrillError)
	expect(failure).toMatchObject({ kind: 'deadline' })
	const progress = await readLatestD1PacedRestoreDrill(env.APP_DB)
	expect(progress?.sources.map((source) => source.error)).toEqual([
		'deadline-exceeded',
		'deadline-exceeded',
	])
})

test('restore drill exits cheaply when DR_D1_PACED_RESTORE_DRILL_ENABLED is off', async () => {
	const { client } = createMemoryS3()
	const env = createEnv({ DR_D1_PACED_RESTORE_DRILL_ENABLED: 'false' })
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	const getTextSpy = vi.spyOn(client, 'getText')
	const getBytesSpy = vi.spyOn(client, 'getBytes')
	const drill = await runD1PacedRestoreDrillTick({
		env,
		now: new Date('2026-10-25T07:05:00.000Z'),
		s3: client,
		day,
	})
	expect(drill).toMatchObject({
		skipped: true,
		reason: 'not-configured',
		sourcesChecked: 0,
		sourcesOk: 0,
	})
	expect(getTextSpy).not.toHaveBeenCalled()
	expect(getBytesSpy).not.toHaveBeenCalled()
})

test('paced status reports staging and sealed presence', async () => {
	const { client } = createMemoryS3()
	const appSqlite = seedSqlite()
	applyDrillProgressMigration(appSqlite)
	const env = createEnv({ APP_DB: createAppD1(appSqlite) })
	expect(
		await collectD1PacedStatus({ env, now: at('01:00'), s3: client }),
	).toMatchObject({
		configured: true,
		stagingPresentCount: 0,
		sealedPresentCount: 0,
	})
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	const status = await collectD1PacedStatus({
		env,
		now: at('06:00'),
		s3: client,
	})
	expect(status).toMatchObject({
		configured: true,
		day,
		stagingPresentCount: 1,
		sealedPresentCount: 1,
		boundCount: 1,
		restoreDrill: null,
	})
	expect(status.sources[0]).toMatchObject({
		name: 'kody',
		stagingPresent: true,
		sealedPresent: true,
		bound: true,
	})
})

function seedWideItems(rowCount: number) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);`,
	)
	for (let i = 1; i <= rowCount; i += 1) {
		sqlite
			.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`)
			.run(`i${i}`, 'x'.repeat(2000))
	}
	return sqlite
}

function gate() {
	let open!: () => void
	const opened = new Promise<void>((resolve) => (open = resolve))
	return { open, opened }
}

/** A tick that stops inside its first page until `resume.open()` is called. */
function startPausedTick(input: {
	env: Env
	client: DrBackupS3Client
	now: Date
	pageSize: number
}) {
	const paused = gate()
	const resume = gate()
	let pages = 0
	const tick = runD1PacedBackupTick({
		env: input.env,
		now: input.now,
		s3: input.client,
		partMaxBytes: 8_000,
		walkerOpts: {
			minPage: input.pageSize,
			maxPage: input.pageSize,
			minGapMs: 0,
			sleep: async () => {},
			onPage: async () => {
				pages += 1
				if (pages !== 1) return
				paused.open()
				await resume.opened
			},
		},
	})
	return { tick, paused: paused.opened, resume: resume.open }
}

async function runNightToSeal(input: {
	env: Env
	client: DrBackupS3Client
	day: string
}) {
	for (let minute = 10; minute < 20; minute += 1) {
		const result = await runD1PacedBackupTick({
			env: input.env,
			now: new Date(`${input.day}T01:${minute}:00.000Z`),
			s3: input.client,
			partMaxBytes: 8_000,
			walkerOpts: { ...fastWalker, minPage: 2, maxPage: 2 },
		})
		if (result.nightsSealed > 0 || result.reason === 'already-complete') return
	}
	throw new Error(`night ${input.day} did not seal`)
}

async function drillItems(input: {
	env: Env
	client: DrBackupS3Client
	day: string
}) {
	await runD1PacedRestoreDrillTick({
		env: input.env,
		now: new Date('2026-11-01T07:05:00.000Z'),
		s3: input.client,
		day: input.day,
	}).catch(() => {})
	const run = await readLatestD1PacedRestoreDrill(input.env.APP_DB)
	return run?.sources[0]?.tables.find((table) => table.table === 'items')
}

test('a second backup tick skips while the first still holds the lane', async () => {
	const { client } = createMemoryS3()
	const sqlite = seedWideItems(40)
	const env = createEnv({ APP_DB: createAppD1(sqlite) })
	const baseDay = '2026-10-25'
	const deltaDay = '2026-10-26'

	const first = startPausedTick({
		env,
		client,
		now: new Date(`${baseDay}T01:00:00.000Z`),
		pageSize: 3,
	})
	await first.paused
	const overlapping = await runD1PacedBackupTick({
		env,
		now: new Date(`${baseDay}T01:00:01.000Z`),
		s3: client,
		partMaxBytes: 8_000,
		walkerOpts: { ...fastWalker, minPage: 2, maxPage: 2 },
	})
	expect(overlapping).toMatchObject({ skipped: true, reason: 'lease-held' })
	first.resume()
	await first.tick

	await runNightToSeal({ env, client, day: baseDay })
	await runNightToSeal({ env, client, day: deltaDay })
	applyDrillProgressMigration(sqlite)
	expect(await drillItems({ env, client, day: deltaDay })).toMatchObject({
		manifestCount: 40,
		restoredCount: 40,
		ok: true,
	})
})

test('a tick that outlived its lease stops before writing over the tick that took the lane', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const { client } = createMemoryS3()
		const sqlite = seedWideItems(40)
		const env = createEnv({ APP_DB: createAppD1(sqlite) })
		const baseDay = '2026-10-25'
		const deltaDay = '2026-10-26'
		vi.setSystemTime(new Date(`${baseDay}T01:00:00.000Z`))

		const stale = startPausedTick({
			env,
			client,
			now: new Date(`${baseDay}T01:00:00.000Z`),
			pageSize: 3,
		})
		await stale.paused
		// The stale tick hangs past its lease, so the next tick takes the lane
		// and writes the same table from the same starting progress.
		vi.setSystemTime(new Date(`${baseDay}T01:05:00.000Z`))
		let pages = 0
		const takeover = await runD1PacedBackupTick({
			env,
			now: new Date(`${baseDay}T01:05:00.000Z`),
			s3: client,
			partMaxBytes: 8_000,
			walkerOpts: {
				...fastWalker,
				minPage: 2,
				maxPage: 2,
				onPage: () => {
					pages += 1
				},
				shouldStop: () => pages >= 4,
			},
		})
		expect(takeover).toMatchObject({ skipped: false, tablesCompleted: 0 })

		stale.resume()
		await expect(stale.tick).rejects.toBeInstanceOf(D1PacedBackupLeaseLostError)

		await runNightToSeal({ env, client, day: baseDay })
		vi.setSystemTime(new Date(`${deltaDay}T01:00:00.000Z`))
		await runNightToSeal({ env, client, day: deltaDay })
		const manifest = parsePacedD1NightManifest(
			JSON.parse(
				(await client.getText(pacedD1StagingManifestKey(deltaDay, 'kody')))!
					.text,
			),
		)
		expect(manifest.tables.items).toMatchObject({ count: 40, deletes: 0 })
		applyDrillProgressMigration(sqlite)
		expect(await drillItems({ env, client, day: deltaDay })).toMatchObject({
			manifestCount: 40,
			restoredCount: 40,
			ok: true,
		})
	} finally {
		vi.useRealTimers()
	}
})

/**
 * Repeat the last `items` part of a night as one more part, with the parts
 * pointer and night manifest digests rewritten to match: the artifact shape
 * two overlapping ticks used to leave behind.
 */
async function repeatLastItemsPart(input: {
	objects: Map<string, { bytes: Uint8Array; etag: string }>
	day: string
	location: 'staging' | 'sealed'
}) {
	const tier = pacedD1RetentionTierForDay(input.day)
	const sealed = input.location === 'sealed'
	const keys = {
		manifest: sealed
			? pacedD1SealedManifestKey(tier, appId, input.day)
			: pacedD1StagingManifestKey(input.day, 'kody'),
		data: sealed
			? pacedD1SealedDataKey(tier, appId, input.day, 'items')
			: pacedD1StagingDataKey(input.day, 'kody', 'items'),
		index: sealed
			? pacedD1SealedIndexKey(tier, appId, input.day, 'items')
			: pacedD1StagingIndexKey(input.day, 'kody', 'items'),
		dataPart: (part: number) =>
			sealed
				? pacedD1SealedDataPartKey(tier, appId, input.day, 'items', part)
				: pacedD1StagingDataPartKey(input.day, 'kody', 'items', part),
		indexPart: (part: number) =>
			sealed
				? pacedD1SealedIndexPartKey(tier, appId, input.day, 'items', part)
				: pacedD1StagingIndexPartKey(input.day, 'kody', 'items', part),
	}
	const readText = (key: string) =>
		new TextDecoder().decode(input.objects.get(key)!.bytes)
	const writeText = (key: string, text: string) => {
		const bytes = encode(text)
		input.objects.set(key, { bytes, etag: etagFor(bytes) })
	}
	const pointer = JSON.parse(readText(keys.data)) as {
		partCount: number
		dataSha256: string
		indexSha256: string
		dataPartDigests: Array<string>
		indexPartDigests: Array<string>
	}
	const last = pointer.partCount - 1
	input.objects.set(
		keys.dataPart(last + 1),
		input.objects.get(keys.dataPart(last))!,
	)
	input.objects.set(
		keys.indexPart(last + 1),
		input.objects.get(keys.indexPart(last))!,
	)
	pointer.partCount += 1
	pointer.dataPartDigests.push(pointer.dataPartDigests[last]!)
	pointer.indexPartDigests.push(pointer.indexPartDigests[last]!)
	pointer.dataSha256 = await sha256HexOfText(
		`${pointer.dataPartDigests.join('\n')}\n`,
	)
	pointer.indexSha256 = await sha256HexOfText(
		`${pointer.indexPartDigests.join('\n')}\n`,
	)
	writeText(keys.data, `${JSON.stringify(pointer)}\n`)
	writeText(keys.index, `${JSON.stringify(pointer)}\n`)
	const manifest = JSON.parse(readText(keys.manifest)) as {
		tables: Record<string, { dataSha256: string; indexSha256: string }>
	}
	manifest.tables.items!.dataSha256 = pointer.dataSha256
	manifest.tables.items!.indexSha256 = pointer.indexSha256
	writeText(keys.manifest, `${JSON.stringify(manifest)}\n`)
}

test('seal rejects a table index that repeats a rowid and writes nothing sealed for it', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv({ APP_DB: createAppD1(seedWideItems(12)) })
	await runNightToSeal({ env, client, day })
	for (const key of objects.keys()) {
		if (!key.startsWith('staging/')) objects.delete(key)
	}
	await repeatLastItemsPart({ objects, day, location: 'staging' })

	await expect(
		sealPacedD1SourceNight({
			s3: client,
			source: { binding: 'APP_DB', name: 'kody', id: appId },
			day,
		}),
	).rejects.toThrow(
		'paced D1 index for kody.items on 2026-10-24 is not strictly increasing: [9] follows [12]',
	)
	expect(
		[...objects.keys()].filter((key) => !key.startsWith('staging/')),
	).toEqual([])
})

test('restore drill counts a rowid the full base carries twice once, like a restore', async () => {
	const { client, objects } = createMemoryS3()
	const sqlite = seedWideItems(12)
	const env = createEnv({ APP_DB: createAppD1(sqlite) })
	const baseDay = '2026-10-25'
	await runNightToSeal({ env, client, day: baseDay })
	await repeatLastItemsPart({ objects, day: baseDay, location: 'sealed' })
	applyDrillProgressMigration(sqlite)

	expect(await drillItems({ env, client, day: baseDay })).toMatchObject({
		manifestCount: 12,
		restoredCount: 12,
		ok: true,
	})
})

function forceFullBaseRequest(day: string, secret = 'restore-secret') {
	return new Request(
		`https://kody.codes/__maintenance/dr-paced-force-full-base?day=${day}`,
		{ method: 'POST', headers: { Authorization: `Bearer ${secret}` } },
	)
}

test('a force-full-base request cuts a full base on a weekday night', async () => {
	const { client } = createMemoryS3()
	const sqlite = seedSqlite(2)
	const env = createEnv({
		APP_DB: createAppD1(sqlite),
		DR_RESTORE_SECRET: 'restore-secret',
	})
	const baseDay = '2026-10-23' // Friday
	const nextDay = '2026-10-24' // Saturday, normally a delta night
	await runD1PacedBackupTick({
		env,
		now: new Date(`${baseDay}T01:00:00.000Z`),
		s3: client,
		walkerOpts: fastWalker,
	})
	const requestedAt = new Date(`${baseDay}T15:00:00.000Z`)
	expect(
		(
			await handleD1PacedForceFullBaseRequest(
				forceFullBaseRequest(nextDay, 'wrong'),
				env,
				client,
				requestedAt,
			)
		).status,
	).toBe(401)
	const tick = await claimD1PacedBackupLease(env.APP_DB)
	expect(
		(
			await handleD1PacedForceFullBaseRequest(
				forceFullBaseRequest(nextDay),
				env,
				client,
				requestedAt,
			)
		).status,
	).toBe(409)
	await tick!.release()
	const accepted = await handleD1PacedForceFullBaseRequest(
		forceFullBaseRequest(nextDay),
		env,
		client,
		requestedAt,
	)
	expect(accepted.status).toBe(200)
	await runD1PacedBackupTick({
		env,
		now: new Date(`${nextDay}T01:00:00.000Z`),
		s3: client,
		walkerOpts: fastWalker,
	})
	const raw = await client.getText(pacedD1StagingManifestKey(nextDay, 'kody'))
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.retentionTier).toBe('daily')
	expect(manifest.tables.items?.mode).toBe('full')
	expect(manifest.tables.items?.count).toBe(2)
	const late = await handleD1PacedForceFullBaseRequest(
		forceFullBaseRequest(nextDay),
		env,
		client,
		new Date(`${nextDay}T02:00:00.000Z`),
	)
	expect(late.status).toBe(409)
})

test('a force-full-base request only accepts today or tomorrow', async () => {
	const { client } = createMemoryS3()
	const env = createEnv({ DR_RESTORE_SECRET: 'restore-secret' })
	const response = await handleD1PacedForceFullBaseRequest(
		forceFullBaseRequest('2026-10-20'),
		env,
		client,
		new Date('2026-10-23T15:00:00.000Z'),
	)
	expect(response.status).toBe(400)
})

const sunday = '2026-10-25'

function seedNarrowItems(rowCount: number) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);`,
	)
	const insert = sqlite.prepare(`INSERT INTO items (id, body) VALUES (?, ?)`)
	sqlite.exec('BEGIN')
	for (let i = 1; i <= rowCount; i += 1) insert.run(`i${i}`, 'b')
	sqlite.exec('COMMIT')
	return sqlite
}

/**
 * Replays a Sunday on the 5 minute cron from 00:00 to the 07:00 DR health
 * check, charging simulated D1 time per page. A tick still running at a cron
 * mark holds the lane, so that mark does no work. Returns UTC HH:MM seal times.
 */
async function replaySundayToHealthCheck(input: {
	rowsPerSource: number
	pageMs: number
	budgets?: { timeBudgetMs: number; tickByteBudget: number }
}) {
	const { client } = createMemoryS3()
	const sources = [
		{ binding: 'APP_DB', name: 'kody', id: appId },
		{ binding: 'AUDIT_DB', name: 'kody-audit', id: auditId },
		{ binding: 'JOBS_DB', name: 'kody-jobs', id: jobsId },
	]
	const env = createEnv({
		DR_D1_PACED_SOURCES: sourcesJson(sources),
		APP_DB: createAppD1(seedNarrowItems(input.rowsPerSource)),
		AUDIT_DB: createD1FromSqlite(seedNarrowItems(input.rowsPerSource)),
		JOBS_DB: createD1FromSqlite(seedNarrowItems(input.rowsPerSource)),
	})
	const tier = pacedD1RetentionTierForDay(sunday)
	const healthCheckMs = Date.parse(`${sunday}T07:00:00.000Z`)
	const sealedAt = new Map<string, string>()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		let mark = Date.parse(`${sunday}T00:00:00.000Z`)
		vi.setSystemTime(mark)
		for (; mark < healthCheckMs; mark += 5 * 60_000) {
			if (sealedAt.size === sources.length) break
			if (Date.now() > mark) continue
			vi.setSystemTime(mark)
			await runD1PacedBackupTick({
				env,
				now: new Date(mark),
				s3: client,
				...input.budgets,
				walkerOpts: {
					minPage: 20,
					maxPage: 20,
					minGapMs: 0,
					sleep: async () => {},
					onPage: () => {
						vi.setSystemTime(Date.now() + input.pageMs)
					},
				},
			})
			for (const source of sources) {
				if (sealedAt.has(source.name)) continue
				const sealed = await client.head(
					pacedD1SealedManifestKey(tier, source.id, sunday),
				)
				if (sealed.exists) {
					sealedAt.set(source.name, new Date().toISOString().slice(11, 16))
				}
			}
		}
	} finally {
		vi.useRealTimers()
	}
	return sealedAt
}

test('a Sunday base too big for 45s ticks still seals all three sources before the 07:00 health check', async () => {
	// 1,800 pages at 3s each is 90 tick-minutes, more than the ~63 that 45s
	// ticks every 5 minutes fit before 07:00 (the 2026-11-22 overrun shape).
	const night = { rowsPerSource: 12_000, pageMs: 3_000 }
	const weekdaySized = await replaySundayToHealthCheck({
		...night,
		budgets: {
			timeBudgetMs: d1PacedBackupRunTimeBudgetMs,
			tickByteBudget: d1PacedBackupTickByteBudget,
		},
	})
	expect(weekdaySized.size).toBeLessThan(3)

	const sealedAt = await replaySundayToHealthCheck(night)
	expect([...sealedAt.keys()].sort()).toEqual([
		'kody',
		'kody-audit',
		'kody-jobs',
	])
	// Headroom: done before 04:00, three hours ahead of the health check.
	for (const time of sealedAt.values()) expect(time < '04:00').toBe(true)
}, 60_000)

test('a large parted table seal stops between parts on budget and resumes without recopying', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv({ APP_DB: createAppD1(seedWideItems(20)) })
	await runNightToSeal({ env, client, day })
	const tier = pacedD1RetentionTierForDay(day)
	let partCount = 0
	while (
		objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', partCount))
	)
		partCount += 1
	expect(partCount).toBeGreaterThan(4)
	const partKeys = Array.from({ length: partCount }, (_, i) => [
		pacedD1SealedDataPartKey(tier, appId, day, 'items', i),
		pacedD1SealedIndexPartKey(tier, appId, day, 'items', i),
	])
	const sealedManifestKey = pacedD1SealedManifestKey(tier, appId, day)
	const tipKeys = [
		pacedD1SealedDataKey(tier, appId, day, 'items'),
		pacedD1SealedIndexKey(tier, appId, day, 'items'),
	]
	const sealedBodies = new Map(
		partKeys.flat().map((key) => [key, objects.get(key)!.bytes]),
	)
	for (const key of [...partKeys.flat(), ...tipKeys, sealedManifestKey]) {
		objects.delete(key)
	}

	const putKeys: Array<string> = []
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		putKeys.push(key)
		const result = await originalPut(key, body, options)
		// Each sealed part pair costs one simulated second.
		if (partKeys.some(([, indexKey]) => indexKey === key)) {
			vi.setSystemTime(Date.now() + 1_000)
		}
		return result
	}
	const source = { binding: 'APP_DB' as const, name: 'kody', id: appId }
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const stalled = await sealPacedD1SourceNight({
			s3: client,
			source,
			day,
			startedAtMs: Date.now(),
			timeBudgetMs: 2_500,
		})
		expect(stalled.complete).toBe(false)
		expect(partKeys.map(([dataKey]) => objects.has(dataKey!))).toEqual(
			Array.from({ length: partCount }, (_, i) => i < 3),
		)
		for (const key of [...tipKeys, sealedManifestKey]) {
			expect(objects.has(key)).toBe(false)
		}
	} finally {
		vi.useRealTimers()
	}

	putKeys.length = 0
	const finished = await sealPacedD1SourceNight({ s3: client, source, day })
	expect(finished.complete).toBe(true)
	expect(putKeys).not.toContain(partKeys[0]![0])
	expect(putKeys).not.toContain(partKeys[2]![1])
	expect(putKeys).toContain(partKeys[3]![0])
	expect(putKeys).toContain(sealedManifestKey)
	for (const [key, bytes] of sealedBodies) {
		expect(objects.get(key)?.bytes).toEqual(bytes)
	}
})

test('a parted table seal makes progress when index validation alone uses the whole budget', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv({ APP_DB: createAppD1(seedWideItems(20)) })
	await runNightToSeal({ env, client, day })
	const tier = pacedD1RetentionTierForDay(day)
	let partCount = 0
	while (
		objects.has(pacedD1StagingDataPartKey(day, 'kody', 'items', partCount))
	)
		partCount += 1
	expect(partCount).toBeGreaterThan(4)
	const sealedManifestKey = pacedD1SealedManifestKey(tier, appId, day)
	for (let i = 0; i < partCount; i += 1) {
		objects.delete(pacedD1SealedDataPartKey(tier, appId, day, 'items', i))
		objects.delete(pacedD1SealedIndexPartKey(tier, appId, day, 'items', i))
	}
	objects.delete(pacedD1SealedDataKey(tier, appId, day, 'items'))
	objects.delete(pacedD1SealedIndexKey(tier, appId, day, 'items'))
	objects.delete(sealedManifestKey)

	const stagingIndexKeys = new Set(
		Array.from({ length: partCount }, (_, i) =>
			pacedD1StagingIndexPartKey(day, 'kody', 'items', i),
		),
	)
	const originalGetBytes = client.getBytes.bind(client)
	client.getBytes = async (key) => {
		// Each staging index read costs one simulated second, so validating the
		// whole index outlasts a 2s budget on its own.
		if (stagingIndexKeys.has(key)) vi.setSystemTime(Date.now() + 1_000)
		return originalGetBytes(key)
	}
	const source = { binding: 'APP_DB' as const, name: 'kody', id: appId }
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		let calls = 0
		let complete = false
		while (!complete && calls <= partCount) {
			calls += 1
			const result = await sealPacedD1SourceNight({
				s3: client,
				source,
				day,
				startedAtMs: Date.now(),
				timeBudgetMs: 2_000,
			})
			if (calls === 1) {
				expect(result.complete).toBe(false)
				expect(
					objects.has(pacedD1SealedDataPartKey(tier, appId, day, 'items', 0)),
				).toBe(true)
			}
			complete = result.complete
		}
		expect(complete).toBe(true)
		expect(objects.has(sealedManifestKey)).toBe(true)
	} finally {
		vi.useRealTimers()
	}
})

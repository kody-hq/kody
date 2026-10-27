import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedIndexKey,
	pacedD1SealedManifestKey,
	pacedD1StagingDataKey,
	pacedD1StagingDataPartKey,
	pacedD1StagingIndexPartKey,
	pacedD1StagingManifestKey,
	pacedD1StagingProgressKey,
	parsePacedD1NightManifest,
	parsePacedD1ProgressCursor,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import {
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
import { sealPacedD1SourceNight } from '#worker/dr/d1-paced-backup-seal.ts'
import { runD1PacedRestoreDrillTick } from '#worker/dr/d1-paced-restore-drill.ts'
import { collectD1PacedStatus } from '#worker/dr/d1-paced-status.ts'
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
		APP_DB: createD1FromSqlite(seedSqlite()),
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
		tablesCompleted: 1,
		day,
	})
	const raw = await client.getText(pacedD1StagingManifestKey(day, 'kody'))
	expect(raw).not.toBeNull()
	const manifest = parsePacedD1NightManifest(JSON.parse(raw!.text))
	expect(manifest.shadow).toBe(true)
	expect(manifest.databaseId).toBe(appId)
	expect(Object.keys(manifest.tables)).toEqual(['items'])
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
		APP_DB: createD1FromSqlite(sqlite),
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

test('resume mid-table continues from lastRowid across ticks', async () => {
	const { client, objects } = createMemoryS3()
	const env = createEnv({
		APP_DB: createD1FromSqlite(seedSqlite(6)),
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
		APP_DB: createD1FromSqlite(sqlite),
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
		tablesSealed: 2,
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
		APP_DB: createD1FromSqlite(seedSqlite(4)),
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
	const env = createEnv({ APP_DB: createD1FromSqlite(sqlite) })
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

test('restore drill verifies sealed night against live counts', async () => {
	const { client } = createMemoryS3()
	const env = createEnv()
	await runD1PacedBackupTick({
		env,
		now: at('01:00'),
		s3: client,
		walkerOpts: fastWalker,
	})
	const drill = await runD1PacedRestoreDrillTick({
		env,
		now: new Date('2026-10-25T07:05:00.000Z'),
		s3: client,
		day,
	})
	expect(drill).toMatchObject({
		skipped: false,
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
	const env = createEnv()
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
	})
	expect(status.sources[0]).toMatchObject({
		name: 'kody',
		stagingPresent: true,
		sealedPresent: true,
		bound: true,
	})
})

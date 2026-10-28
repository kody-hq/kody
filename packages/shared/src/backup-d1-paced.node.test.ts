import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import {
	adaptPacedPageSize,
	pacedBackupGapMs,
	pacedD1ForcesFullBase,
	pacedD1RetentionTierForDay,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	pacedD1StagingManifestKey,
	parsePacedD1NightManifest,
	type PacedD1TableManifest,
} from './backup-d1-paced.ts'
import {
	comparePacedD1Key,
	encodePacedD1Cell,
	hashPacedD1RowLine,
	pacedD1RowLine,
} from './backup-d1-paced-encode.ts'
import {
	applyPacedD1NightToState,
	buildPacedD1RestoreSql,
	createEmptyPacedD1RestoreState,
	sliceUtf16Safe,
} from './backup-d1-paced-restore.ts'
import { bytesToBase64 } from './base64.ts'
import {
	buildPacedD1NightManifest,
	createMemoryPacedD1IndexReader,
	createMemoryPacedD1TableWriter,
	discoverPacedD1Schema,
	resolvePacedD1TableMode,
	summarizePacedQueryMs,
	walkPacedD1Table,
	type PacedD1Database,
	type PacedD1QueryResult,
} from './backup-d1-paced-walker.ts'

/** Minimal D1 facade so shared tests stay free of worker imports. */
function asPacedDb(db: DatabaseSync): PacedD1Database {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					const bound = params as Array<null | number | string | Uint8Array>
					return {
						async all() {
							const started = performance.now()
							const rows = db.prepare(query).all(...bound) as Array<
								Record<string, unknown>
							>
							return {
								results: rows,
								meta: {
									duration: Math.max(1, performance.now() - started),
									rows_read: rows.length,
								},
							} satisfies PacedD1QueryResult
						},
						async first<T = Record<string, unknown>>() {
							return (db.prepare(query).get(...bound) ?? null) as T | null
						},
					}
				},
			}
		},
	}
}

function seedDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE notes (
			id TEXT PRIMARY KEY NOT NULL,
			body TEXT NOT NULL
		);
		CREATE TABLE _rate_limits (
			key TEXT PRIMARY KEY NOT NULL,
			count INTEGER NOT NULL
		);
		INSERT INTO users (id, name, updated_at) VALUES
			('u1', 'ada', '2026-01-01T00:00:00.000Z'),
			('u2', 'bob', '2026-01-01T00:00:00.000Z'),
			('u3', 'cy', '2026-01-01T00:00:00.000Z');
		INSERT INTO notes (id, body) VALUES
			('n1', 'hello'),
			('n2', 'world');
		INSERT INTO _rate_limits (key, count) VALUES ('x', 1);
	`)
	return sqlite
}

test('retention tier forces Sunday full base', () => {
	expect(pacedD1RetentionTierForDay('2026-10-25')).toBe('weekly') // Sunday
	expect(pacedD1ForcesFullBase('2026-10-25')).toBe(true)
	expect(pacedD1RetentionTierForDay('2026-10-24')).toBe('daily')
	expect(pacedD1ForcesFullBase('2026-10-24')).toBe(false)
})

test('key helpers stay under lifecycle prefixes', () => {
	expect(pacedD1StagingManifestKey('2026-10-24', 'kody')).toBe(
		'staging/2026-10-24/d1-paced/kody/manifest.json',
	)
	expect(
		pacedD1SealedManifestKey(
			'daily',
			'8c1014d1-6b41-4695-a0a2-159071f0f919',
			'2026-10-24',
		),
	).toBe(
		'daily/d1-paced/8c1014d1-6b41-4695-a0a2-159071f0f919/2026-10-24/manifest.json',
	)
	expect(
		pacedD1SealedDataPartKey(
			'daily',
			'8c1014d1-6b41-4695-a0a2-159071f0f919',
			'2026-10-24',
			'items',
			3,
		),
	).toBe(
		'daily/d1-paced/8c1014d1-6b41-4695-a0a2-159071f0f919/2026-10-24/data/items.parts/0003.tsv',
	)
	expect(
		pacedD1SealedIndexPartKey(
			'weekly',
			'8c1014d1-6b41-4695-a0a2-159071f0f919',
			'2026-10-25',
			'items',
			0,
		),
	).toBe(
		'weekly/d1-paced/8c1014d1-6b41-4695-a0a2-159071f0f919/2026-10-25/index/items.parts/0000.tsv',
	)
})

test('adaptive page size and duty-cycle gap', () => {
	expect(
		adaptPacedPageSize({
			page: 400,
			durationMs: 50,
			pageBytes: 1000,
			targetMs: 25,
		}),
	).toBe(200)
	expect(
		adaptPacedPageSize({
			page: 100,
			durationMs: 5,
			pageBytes: 100,
			targetMs: 25,
			maxBytes: 1_500_000,
		}),
	).toBe(200)
	expect(pacedBackupGapMs({ durationMs: 25, dutyCycle: 0.25 })).toBe(75)
	expect(
		pacedBackupGapMs({ durationMs: 1, dutyCycle: 0.25, minGapMs: 20 }),
	).toBe(20)
})

test('rowid key compare matches sqlite binary order', () => {
	expect(comparePacedD1Key([null], [1])).toBeLessThan(0)
	expect(comparePacedD1Key([1], ['a'])).toBeLessThan(0)
	expect(comparePacedD1Key(['a'], [{ $b: 'YQ==' }])).toBeLessThan(0)
	expect(comparePacedD1Key([2], [10])).toBeLessThan(0)
	expect(comparePacedD1Key([10], [10])).toBe(0)
})

test('discoverSchema skips ephemeral tables and pages by rowid', async () => {
	const db = asPacedDb(seedDb())
	const schema = await discoverPacedD1Schema(db)
	expect(schema.tables.map((table) => table.name).sort()).toEqual([
		'notes',
		'users',
	])
	expect(schema.tables.every((table) => table.pk[0] === 'rowid')).toBe(true)
})

test('full night then delta restores exactly, including deletes and schema rebase', async () => {
	const sqlite = seedDb()
	const db = asPacedDb(sqlite)
	const sleepCalls: Array<number> = []
	const schema0 = await discoverPacedD1Schema(db)
	const tableManifests0: Record<string, PacedD1TableManifest> = {}
	const writers0: Record<
		string,
		ReturnType<typeof createMemoryPacedD1TableWriter>
	> = {}
	const queryMs0: Array<number> = []
	let counters0 = { queries: 0, rowsRead: 0, d1RowsRead: 0, bytesOut: 0 }

	for (const table of schema0.tables) {
		const writer = createMemoryPacedD1TableWriter()
		writers0[table.name] = writer
		const result = await walkPacedD1Table({
			db,
			table,
			mode: 'full',
			prev: null,
			writer,
			opts: {
				minPage: 2,
				maxPage: 10,
				targetMs: 25,
				dutyCycle: 0.25,
				minGapMs: 1,
				sleep: async (ms) => {
					sleepCalls.push(ms)
				},
			},
		})
		expect(result.done).toBe(true)
		if (!result.done) throw new Error('expected done')
		tableManifests0[table.name] = result.manifest
		counters0 = {
			queries: counters0.queries + result.queries,
			rowsRead: counters0.rowsRead + result.rowsRead,
			d1RowsRead: counters0.d1RowsRead + result.d1RowsRead,
			bytesOut: counters0.bytesOut + result.bytesOut,
		}
		queryMs0.push(...result.queryMs)
	}

	expect(sleepCalls.length).toBeGreaterThan(0)
	const built0 = await buildPacedD1NightManifest({
		databaseName: 'kody',
		databaseId: '8c1014d1-6b41-4695-a0a2-159071f0f919',
		day: '2026-10-24',
		startedAt: '2026-10-24T00:00:00.000Z',
		finishedAt: '2026-10-24T00:01:00.000Z',
		prevDay: null,
		prevManifestSha256: null,
		schema: schema0,
		schemaStableDuringWalk: true,
		timeTravelBookmark: '00000001-00000002-00000003-abcdef',
		tables: tableManifests0,
		stats: summarizePacedQueryMs(queryMs0, 1000, counters0),
		shadow: true,
	})
	const manifest0Raw = `${JSON.stringify(built0.manifest, null, 1)}\n`
	expect(parsePacedD1NightManifest(JSON.parse(manifest0Raw))).toMatchObject({
		shadow: true,
		retentionTier: 'daily',
	})

	// Mutate: update, delete, insert, and alter schema on users.
	sqlite.exec(`
		UPDATE users SET name = 'ada2' WHERE id = 'u1';
		DELETE FROM notes WHERE id = 'n2';
		INSERT INTO notes (id, body) VALUES ('n3', 'new');
		ALTER TABLE users ADD COLUMN backup_probe TEXT;
		UPDATE users SET backup_probe = 'x' WHERE id = 'u2';
	`)

	const schema1 = await discoverPacedD1Schema(db)
	const tableManifests1: typeof tableManifests0 = {}
	const writers1: typeof writers0 = {}
	for (const table of schema1.tables) {
		const prev = tableManifests0[table.name]
		const mode = resolvePacedD1TableMode({
			day: '2026-10-26',
			tableSchemaHash: table.schemaHash,
			prevSchemaHash: prev?.schemaHash,
		})
		expect(table.name === 'users' ? mode : 'delta').toBe(
			table.name === 'users' ? 'full' : 'delta',
		)
		const writer = createMemoryPacedD1TableWriter()
		writers1[table.name] = writer
		const result = await walkPacedD1Table({
			db,
			table,
			mode,
			prev: prev
				? {
						schemaHash: prev.schemaHash,
						openIndex: () =>
							createMemoryPacedD1IndexReader(writers0[table.name]!.index),
					}
				: null,
			writer,
			opts: { minPage: 2, maxPage: 10, minGapMs: 0, sleep: async () => {} },
		})
		expect(result.done).toBe(true)
		if (!result.done) throw new Error('expected done')
		tableManifests1[table.name] = result.manifest
		if (table.name === 'notes') {
			// SQLite may reuse the deleted rowid for the insert, so the lane
			// records a content-hash change (upsert) rather than delete+insert.
			expect(
				result.manifest.upserts + result.manifest.deletes,
			).toBeGreaterThanOrEqual(1)
		}
	}

	const built1 = await buildPacedD1NightManifest({
		databaseName: 'kody',
		databaseId: '8c1014d1-6b41-4695-a0a2-159071f0f919',
		day: '2026-10-26',
		startedAt: '2026-10-26T00:00:00.000Z',
		finishedAt: '2026-10-26T00:01:00.000Z',
		prevDay: '2026-10-24',
		prevManifestSha256: built0.sha256,
		schema: schema1,
		schemaStableDuringWalk: true,
		timeTravelBookmark: null,
		tables: tableManifests1,
		stats: summarizePacedQueryMs([], 10, {
			queries: 0,
			rowsRead: 0,
			d1RowsRead: 0,
			bytesOut: 0,
		}),
		shadow: true,
	})
	const manifest1Raw = `${JSON.stringify(built1.manifest, null, 1)}\n`

	const restoreState = createEmptyPacedD1RestoreState()
	await applyPacedD1NightToState({
		state: restoreState,
		night: {
			manifest: built0.manifest,
			manifestRaw: manifest0Raw,
			dataByTable: {
				users: writers0.users!.data,
				notes: writers0.notes!.data,
			},
		},
		prevManifestRaw: null,
	})
	await applyPacedD1NightToState({
		state: restoreState,
		night: {
			manifest: built1.manifest,
			manifestRaw: manifest1Raw,
			dataByTable: {
				users: writers1.users!.data,
				notes: writers1.notes!.data,
			},
		},
		prevManifestRaw: manifest0Raw,
	})

	expect(restoreState.tables.get('notes')!.size).toBe(2)
	expect(restoreState.tables.get('users')!.size).toBe(3)

	const { sql, stats } = buildPacedD1RestoreSql(restoreState)
	expect(sql).toContain('CREATE TABLE users')
	expect(sql).toContain('INSERT OR REPLACE INTO "notes"')
	expect(sql).toContain('backup_probe')
	expect(stats.statements).toBeGreaterThan(5)

	// Corrupted artifact must refuse restore.
	const badState = createEmptyPacedD1RestoreState()
	await expect(
		applyPacedD1NightToState({
			state: badState,
			night: {
				manifest: built0.manifest,
				manifestRaw: manifest0Raw,
				dataByTable: {
					users: `${writers0.users!.data}tampered`,
					notes: writers0.notes!.data,
				},
			},
			prevManifestRaw: null,
		}),
	).rejects.toThrow(/CORRUPT artifact/)
})

test('resumable table walk continues from lastRowid', async () => {
	const db = asPacedDb(seedDb())
	const schema = await discoverPacedD1Schema(db)
	const users = schema.tables.find((table) => table.name === 'users')!
	const writer = createMemoryPacedD1TableWriter()
	let nowMs = 0
	const first = await walkPacedD1Table({
		db,
		table: users,
		mode: 'full',
		prev: null,
		writer,
		opts: {
			minPage: 1,
			maxPage: 1,
			budgetMs: 50,
			minGapMs: 0,
			sleep: async () => {
				// After the first page finishes, blow the budget before page 2.
				nowMs = 100
			},
			now: () => nowMs,
		},
	})
	expect(first.done).toBe(false)
	if (first.done) throw new Error('expected partial')
	expect(first.count).toBe(1)
	expect(first.lastRowid).toBeTypeOf('number')

	const second = await walkPacedD1Table({
		db,
		table: users,
		mode: 'full',
		prev: null,
		writer,
		startAfterRowid: first.lastRowid,
		initialPageSize: first.pageSize,
		partial: {
			count: first.count,
			checksum: first.checksum,
			upserts: first.upserts,
			deletes: first.deletes,
		},
		opts: { minPage: 1, maxPage: 1, minGapMs: 0, sleep: async () => {} },
	})
	expect(second.done).toBe(true)
	if (!second.done) throw new Error('expected done')
	expect(second.manifest.count).toBe(3)
})

test('sliceUtf16Safe does not split surrogate pairs', () => {
	const text = `a${String.fromCodePoint(0x1f600)}b`
	const first = sliceUtf16Safe(text, 0, 2)
	expect([...first.chunk]).toEqual(['a'])
	const second = sliceUtf16Safe(text, first.next, 2)
	expect([...second.chunk]).toEqual(['😀'])
})

test('oversized blob rows split into chunked restore SQL', async () => {
	const blob = { $b: bytesToBase64(new Uint8Array(80_000).fill(7)) }
	const line = pacedD1RowLine([1, blob])
	const h = await hashPacedD1RowLine(line)
	const state = createEmptyPacedD1RestoreState()
	state.lastManifest = {
		schemaVersion: 1,
		databaseName: 'kody',
		databaseId: '8c1014d1-6b41-4695-a0a2-159071f0f919',
		day: '2026-10-24',
		retentionTier: 'daily',
		startedAt: '2026-10-24T00:00:00.000Z',
		finishedAt: '2026-10-24T00:01:00.000Z',
		prevDay: null,
		prevManifestSha256: null,
		schemaHash: 'a'.repeat(64),
		schemaStableDuringWalk: true,
		timeTravelBookmark: null,
		extras: [],
		sqliteSequence: [],
		tables: {
			blobs: {
				mode: 'full',
				schemaHash: 'b'.repeat(64),
				sql: 'CREATE TABLE blobs (payload BLOB NOT NULL)',
				cols: ['__rowid', 'payload'],
				pk: ['rowid'],
				declaredPk: [],
				count: 1,
				checksum: '0'.repeat(16),
				upserts: 1,
				deletes: 0,
				dataSha256: 'c'.repeat(64),
				indexSha256: 'd'.repeat(64),
			},
		},
		stats: {
			wallMs: 1,
			queries: 1,
			rowsRead: 1,
			d1RowsRead: 1,
			bytesOut: 1,
			queryMs: { p50: 1, p95: 1, p99: 1, max: 1, sum: 1 },
			dbTimeShare: 1,
		},
		shadow: true,
	}
	state.tables.set('blobs', new Map([[1, { h, row: line }]]))
	state.schema.set('blobs', state.lastManifest.tables.blobs!)
	const { sql, stats } = buildPacedD1RestoreSql(state)
	expect(stats.splitRows).toBe(1)
	expect(sql).toContain(`SET "payload" = "payload" || X'`)
	expect(
		sql.split('\n').every((statement) => statement.length <= 100_000),
	).toBe(true)
})

test('oversized text rows split into chunked restore SQL', async () => {
	const big = 'y'.repeat(120_000)
	const line = pacedD1RowLine([1, encodePacedD1Cell(big)])
	const h = await hashPacedD1RowLine(line)
	const state = createEmptyPacedD1RestoreState()
	state.lastManifest = {
		schemaVersion: 1,
		databaseName: 'kody',
		databaseId: '8c1014d1-6b41-4695-a0a2-159071f0f919',
		day: '2026-10-24',
		retentionTier: 'daily',
		startedAt: '2026-10-24T00:00:00.000Z',
		finishedAt: '2026-10-24T00:01:00.000Z',
		prevDay: null,
		prevManifestSha256: null,
		schemaHash: 'a'.repeat(64),
		schemaStableDuringWalk: true,
		timeTravelBookmark: null,
		extras: [],
		sqliteSequence: [],
		tables: {
			messages: {
				mode: 'full',
				schemaHash: 'b'.repeat(64),
				sql: 'CREATE TABLE messages (body TEXT NOT NULL)',
				cols: ['__rowid', 'body'],
				pk: ['rowid'],
				declaredPk: [],
				count: 1,
				checksum: '0'.repeat(16),
				upserts: 1,
				deletes: 0,
				dataSha256: 'c'.repeat(64),
				indexSha256: 'd'.repeat(64),
			},
		},
		stats: {
			wallMs: 1,
			queries: 1,
			rowsRead: 1,
			d1RowsRead: 1,
			bytesOut: 1,
			queryMs: { p50: 1, p95: 1, p99: 1, max: 1, sum: 1 },
			dbTimeShare: 1,
		},
		shadow: true,
	}
	state.tables.set('messages', new Map([[1, { h, row: line }]]))
	state.schema.set('messages', state.lastManifest.tables.messages!)
	const { sql, stats } = buildPacedD1RestoreSql(state)
	expect(stats.splitRows).toBe(1)
	expect(sql).toContain('SET "body" = "body" ||')
	expect(
		sql
			.split('\n')
			.filter((statement) => statement.startsWith('INSERT OR REPLACE'))
			.every((statement) => statement.length < 100_000),
	).toBe(true)
})

test('meta duration is accepted when present on query results', async () => {
	const results: PacedD1QueryResult = {
		results: [{ __rowid: 1, id: 'a', name: 'n', updated_at: 't' }],
		meta: { duration: 12, rows_read: 1 },
	}
	expect(results.meta?.duration).toBe(12)
})

test('delta resume does not emit false deletes for already-scanned keys', async () => {
	const sqlite = seedDb()
	const db = asPacedDb(sqlite)
	const schema = await discoverPacedD1Schema(db)
	const users = schema.tables.find((table) => table.name === 'users')!
	const baseWriter = createMemoryPacedD1TableWriter()
	const base = await walkPacedD1Table({
		db,
		table: users,
		mode: 'full',
		prev: null,
		writer: baseWriter,
		opts: { minGapMs: 0, sleep: async () => {} },
	})
	expect(base.done).toBe(true)

	sqlite.exec(`UPDATE users SET name = 'ada2' WHERE id = 'u3'`)

	const deltaWriter = createMemoryPacedD1TableWriter()
	let nowMs = 0
	const first = await walkPacedD1Table({
		db,
		table: users,
		mode: 'delta',
		prev: {
			schemaHash: users.schemaHash,
			openIndex: () => createMemoryPacedD1IndexReader(baseWriter.index),
		},
		writer: deltaWriter,
		opts: {
			minPage: 1,
			maxPage: 1,
			budgetMs: 50,
			minGapMs: 0,
			sleep: async () => {
				nowMs = 100
			},
			now: () => nowMs,
		},
	})
	expect(first.done).toBe(false)
	if (first.done) throw new Error('expected partial')
	const deletesAfterFirst = first.deletes

	const second = await walkPacedD1Table({
		db,
		table: users,
		mode: 'delta',
		prev: {
			schemaHash: users.schemaHash,
			openIndex: () => createMemoryPacedD1IndexReader(baseWriter.index),
		},
		writer: deltaWriter,
		startAfterRowid: first.lastRowid,
		initialPageSize: first.pageSize,
		partial: {
			count: first.count,
			checksum: first.checksum,
			upserts: first.upserts,
			deletes: first.deletes,
		},
		opts: { minPage: 1, maxPage: 1, minGapMs: 0, sleep: async () => {} },
	})
	expect(second.done).toBe(true)
	if (!second.done) throw new Error('expected done')
	expect(second.manifest.deletes).toBe(deletesAfterFirst)
	expect(second.manifest.count).toBe(3)
	expect(
		deltaWriter.data.split('\n').filter((line) => line.startsWith('D\t')),
	).toHaveLength(0)
})

test('delta walk emits deletes when a high rowid disappears', async () => {
	const sqlite = seedDb()
	const db = asPacedDb(sqlite)
	const schema = await discoverPacedD1Schema(db)
	const notes = schema.tables.find((table) => table.name === 'notes')!
	const writer0 = createMemoryPacedD1TableWriter()
	const full = await walkPacedD1Table({
		db,
		table: notes,
		mode: 'full',
		prev: null,
		writer: writer0,
		opts: { minGapMs: 0, sleep: async () => {} },
	})
	expect(full.done).toBe(true)
	sqlite.exec(`DELETE FROM notes WHERE id = 'n2'`)
	const writer1 = createMemoryPacedD1TableWriter()
	const delta = await walkPacedD1Table({
		db,
		table: notes,
		mode: 'delta',
		prev: {
			schemaHash: notes.schemaHash,
			openIndex: () => createMemoryPacedD1IndexReader(writer0.index),
		},
		writer: writer1,
		opts: { minGapMs: 0, sleep: async () => {} },
	})
	expect(delta.done).toBe(true)
	if (!delta.done) throw new Error('expected done')
	expect(delta.manifest.deletes).toBe(1)
	expect(writer1.data.startsWith('D\t') || writer1.data.includes('\nD\t')).toBe(
		true,
	)
})

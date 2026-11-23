import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	d1ImportMaxStatementBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { publishBuildRetentionMs, publishOffloadLimits } from './policy.ts'
import { sha256Hex } from './module-hashes.ts'
import {
	authenticatePublishBuildTicket,
	reservePublishBuildChunk,
	publishBuildBlobKey,
	publishBuildDocumentKey,
	purgeExpiredPublishBuilds,
	readPublishBuildDocument,
	sealPublishBuild,
	finishPublishBuild,
} from './store.ts'

function memoryBucket() {
	const objects = new Map<string, string>()
	return {
		objects,
		put: async (key: string, body: string) => {
			objects.set(key, body)
		},
		get: async (key: string) => {
			const body = objects.get(key)
			return body === undefined ? null : { text: async () => body }
		},
	}
}

test('seal and finish preserve their source restrictions including committed rewrites', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT, document_sha256 TEXT, updated_at TEXT, message TEXT, committed_at TEXT)`,
	)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	const db = createD1FromSqlite(sqlite)
	const bucket = memoryBucket() as unknown as R2Bucket
	const statuses = ['uploading', 'sealed', 'committed', 'rejected'] as const
	const document = {
		builderVersion: 2,
		commit: 'commit',
		files: [],
		targets: [],
	}
	for (const status of statuses) {
		sqlite
			.prepare(`INSERT INTO publish_builds (id, status) VALUES (?, ?)`)
			.run(status, status)
		expect(
			await sealPublishBuild({ db, bucket, buildId: status, document }),
		).toBe(status === 'uploading')
	}
	for (const target of ['committed', 'rejected'] as const) {
		for (const source of statuses) {
			sqlite
				.prepare(`UPDATE publish_builds SET status = ? WHERE id = ?`)
				.run(source, source)
			await finishPublishBuild({ db, buildId: source, status: target })
			expect(
				sqlite
					.prepare(`SELECT status FROM publish_builds WHERE id = ?`)
					.get(source),
			).toMatchObject({
				status: source === 'sealed' || source === 'committed' ? target : source,
			})
		}
	}
	expect(
		await sealPublishBuild({ db, bucket, buildId: 'missing', document }),
	).toBe(false)
	await finishPublishBuild({ db, buildId: 'missing', status: 'rejected' })
})

function fakeDb(rows: Array<{ id: string; status: string }>) {
	const statements: Array<{ sql: string; args: Array<unknown> }> = []
	return {
		statements,
		prepare(sql: string) {
			return {
				bind(...args: Array<unknown>) {
					statements.push({ sql, args })
					return {
						all: async () => ({ results: rows }),
						run: async () => ({ meta: { changes: 1 } }),
					}
				},
			}
		},
	}
}

function fakeBucket(keys: Array<string>) {
	const objects = new Set(keys)
	return {
		objects,
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		}),
		delete: async (deleted: Array<string>) => {
			for (const key of deleted) objects.delete(key)
		},
	}
}

test('expired builds lose their chunks; committed rows stay for build origin', async () => {
	const db = fakeDb([
		{ id: 'pb_abandoned', status: 'uploading' },
		{ id: 'pb_done', status: 'committed' },
	])
	const bucket = fakeBucket([
		publishBuildBlobKey('pb_abandoned', 'a'.repeat(64)),
		publishBuildBlobKey('pb_done', 'b'.repeat(64)),
		publishBuildDocumentKey('pb_done', 'd'.repeat(64)),
		publishBuildBlobKey('pb_live', 'c'.repeat(64)),
	])
	const now = Date.parse('2026-11-03T12:00:00Z')
	const purged = await purgeExpiredPublishBuilds({
		db: db as unknown as D1Database,
		bucket: bucket as unknown as R2Bucket,
		now,
	})
	expect(purged).toBe(2)
	expect([...bucket.objects]).toEqual([
		publishBuildBlobKey('pb_live', 'c'.repeat(64)),
	])
	const [select, ...writes] = db.statements
	expect(select!.args[0]).toBe(
		new Date(now - publishBuildRetentionMs).toISOString(),
	)
	expect(
		writes.map((write) => write.sql.trim().split(/\s+/).slice(0, 3).join(' ')),
	).toEqual([
		'DELETE FROM publish_builds',
		'DELETE FROM publish_build_chunks',
		'UPDATE publish_builds SET',
		'DELETE FROM publish_build_chunks',
	])
	expect(writes[2]!.sql).toContain('document_sha256 = NULL')
})

test('a sealed document too large for a D1 import statement stays in R2', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT, document_sha256 TEXT, updated_at TEXT)`,
	)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, status) VALUES ('pb_big', 'uploading')`,
		)
		.run()
	const db = createD1FromSqlite(sqlite)
	const bucket = memoryBucket()
	const files = Array.from({ length: 2_000 }, (_, index) => ({
		path: `src/generated/file-${String(index).padStart(5, '0')}.ts`,
		size: index,
		sha256: 'e'.repeat(64),
	}))
	const document = { builderVersion: 2, commit: 'commit', files, targets: [] }
	expect(utf8ByteLength(JSON.stringify(document))).toBeGreaterThan(
		d1ImportMaxStatementBytes,
	)

	expect(
		await sealPublishBuild({
			db,
			bucket: bucket as unknown as R2Bucket,
			buildId: 'pb_big',
			document,
		}),
	).toBe(true)

	const row = sqlite
		.prepare(`SELECT * FROM publish_builds WHERE id = 'pb_big'`)
		.get() as { id: string; status: string; document_sha256: string }
	expect(row.status).toBe('sealed')
	expect(row.document_sha256).toMatch(/^[0-9a-f]{64}$/)
	expect(utf8ByteLength(JSON.stringify(row))).toBeLessThan(1_000)
	expect([...bucket.objects.keys()]).toEqual([
		publishBuildDocumentKey('pb_big', row.document_sha256),
	])
	expect(
		await readPublishBuildDocument({
			bucket: bucket as unknown as R2Bucket,
			row,
		}),
	).toEqual({ kind: 'ok', value: document })
})

test('a committed build that still had a document before 0289 is purged after it', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT, document_json TEXT, updated_at TEXT, expires_at TEXT)`,
	)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, status, document_json, expires_at) VALUES ('pb_old', 'committed', '{}', '2026-11-01T00:00:00Z')`,
		)
		.run()
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0289-publish-build-documents-in-r2.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const bucket = fakeBucket([publishBuildBlobKey('pb_old', 'a'.repeat(64))])

	const purged = await purgeExpiredPublishBuilds({
		db: createD1FromSqlite(sqlite),
		bucket: bucket as unknown as R2Bucket,
		now: Date.parse('2026-11-03T12:00:00Z'),
	})

	expect(purged).toBe(1)
	expect([...bucket.objects]).toEqual([])
	expect(
		sqlite.prepare(`SELECT document_sha256 FROM publish_builds`).get(),
	).toEqual({ document_sha256: null })
})

test('an expired ticket is refused; the same ticket works before expiry', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT, ticket_sha256 TEXT, expires_at TEXT)`,
	)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	const ticket = 'kpb_expiring'
	const expiresAt = Date.parse('2026-11-22T12:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, status, ticket_sha256, expires_at) VALUES (?, 'uploading', ?, ?)`,
		)
		.run('pb_1', await sha256Hex(ticket), new Date(expiresAt).toISOString())
	const db = createD1FromSqlite(sqlite)
	const authenticate = (now: number) =>
		authenticatePublishBuildTicket({ db, buildId: 'pb_1', ticket, now })
	expect(await authenticate(expiresAt - 1)).toMatchObject({ id: 'pb_1' })
	expect(await authenticate(expiresAt)).toBeNull()
	expect(await authenticate(expiresAt + 60_000)).toBeNull()
})

test('chunk reservations are atomic per build and count each chunk once', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT)`)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	const { maxBlobsPerBuild, maxUploadBytes } = publishOffloadLimits
	sqlite.exec(
		`INSERT INTO publish_builds (id, status) VALUES ('pb_1', 'uploading')`,
	)
	const seed = sqlite.prepare(
		`INSERT INTO publish_build_chunks (build_id, sha256, bytes) VALUES ('pb_1', ?, 1)`,
	)
	for (let index = 0; index < maxBlobsPerBuild - 2; index++)
		seed.run(`seed-${index}`)
	const db = createD1FromSqlite(sqlite)
	const reserve = (sha256: string, bytes = 10) =>
		reservePublishBuildChunk({ db, buildId: 'pb_1', sha256, bytes })
	const kinds = (
		await Promise.all(
			Array.from({ length: 5 }, (_, index) => reserve(`new-${index}`)),
		)
	).map((result) => result.kind)
	expect(kinds.filter((kind) => kind === 'reserved')).toHaveLength(2)
	expect(kinds.filter((kind) => kind === 'too_many_chunks')).toHaveLength(3)
	expect(await reserve('new-0')).toEqual({ kind: 'reserved' })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS chunks FROM publish_build_chunks`).get(),
	).toEqual({ chunks: maxBlobsPerBuild })
	sqlite.exec(`DELETE FROM publish_build_chunks`)
	sqlite
		.prepare(
			`INSERT INTO publish_build_chunks (build_id, sha256, bytes) VALUES ('pb_1', 'big', ?)`,
		)
		.run(maxUploadBytes - 5)
	expect(await reserve('a', 6)).toEqual({ kind: 'upload_too_large' })
	expect(await reserve('a', 5)).toEqual({ kind: 'reserved' })
	sqlite.exec(`UPDATE publish_builds SET status = 'sealed'`)
	expect(await reserve('b', 1)).toEqual({
		kind: 'not_uploading',
		status: 'sealed',
	})
})

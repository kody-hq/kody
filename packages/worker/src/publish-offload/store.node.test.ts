import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { publishBuildRetentionMs } from './policy.ts'
import {
	publishBuildBlobKey,
	purgeExpiredPublishBuilds,
	sealPublishBuild,
	finishPublishBuild,
} from './store.ts'

test('seal and finish preserve their source restrictions including committed rewrites', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, status TEXT, document_json TEXT, updated_at TEXT, message TEXT, committed_at TEXT)`,
	)
	const db = createD1FromSqlite(sqlite)
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
		expect(await sealPublishBuild({ db, buildId: status, document })).toBe(
			status === 'uploading',
		)
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
	expect(await sealPublishBuild({ db, buildId: 'missing', document })).toBe(
		false,
	)
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
	expect(writes.map((write) => write.sql.trim().split(/\s+/)[0])).toEqual([
		'DELETE',
		'UPDATE',
	])
	expect(writes[1]!.sql).toContain('document_json = NULL')
})

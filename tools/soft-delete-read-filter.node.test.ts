import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { scanSoftDeleteReadFilter } from './soft-delete-read-filter.ts'

async function readFilterFixture(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), 'soft-delete-read-filter-'))
	for (const [file, contents] of Object.entries(files)) {
		const absolute = path.join(root, file)
		await mkdir(path.dirname(absolute), { recursive: true })
		await writeFile(absolute, contents)
	}
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

test('soft-delete read filter catches unfiltered SELECT on soft-delete tables', async () => {
	await using fixture = await readFilterFixture({
		'packages/worker/src/orgs/leak.ts': `
			export function read(db: D1Database) {
				return db.prepare('SELECT * FROM orgs WHERE id = ?')
			}
		`,
	})
	const violations = await scanSoftDeleteReadFilter(fixture.root)
	expect(violations).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				file: 'packages/worker/src/orgs/leak.ts',
				message: expect.stringContaining('SELECT on soft-delete table(s) orgs'),
			}),
		]),
	)
})

test('soft-delete read filter accepts inline deleted_at and helper templates', async () => {
	await using fixture = await readFilterFixture({
		'packages/worker/src/orgs/live-inline.ts': `
			export function read(db: D1Database, id: string) {
				return db.prepare(
					'SELECT id FROM orgs WHERE id = ? AND o.deleted_at IS NULL',
				).bind(id)
			}
		`,
		'packages/worker/src/orgs/live-helper.ts': `
			import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
			export function read(db: D1Database, id: string) {
				return db.prepare(
					\`SELECT id FROM orgs WHERE id = ?\${andLiveDeletedAtSql()}\`,
				).bind(id)
			}
		`,
		'packages/worker/src/orgs/purge-writer.ts': `
			// soft-delete-read-filter: opt-out
			export function purge(db: D1Database) {
				return db.prepare('DELETE FROM users WHERE id = ?')
			}
		`,
	})
	const violations = await scanSoftDeleteReadFilter(fixture.root)
	expect(violations).toEqual([])
})

test('soft-delete read filter allows soft-delete claim UPDATE without live filter', async () => {
	await using fixture = await readFilterFixture({
		'packages/worker/src/orgs/soft-delete.ts': `
			export function mark(db: D1Database, id: string, now: string) {
				return db.prepare(
					'UPDATE orgs SET deleted_at = ?, deleting_at = ? WHERE id = ?',
				).bind(now, now, id)
			}
		`,
	})
	const violations = await scanSoftDeleteReadFilter(fixture.root)
	expect(violations).toEqual([])
})

test('soft-delete read filter scans jobs-worker src', async () => {
	await using fixture = await readFilterFixture({
		'packages/jobs-worker/src/jobs/leak.ts': `
			export function read(db: D1Database) {
				return db.prepare('SELECT id FROM jobs')
			}
		`,
	})
	const violations = await scanSoftDeleteReadFilter(fixture.root)
	expect(violations).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				file: 'packages/jobs-worker/src/jobs/leak.ts',
				message: expect.stringContaining('jobs'),
			}),
		]),
	)
})

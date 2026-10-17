import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getMemoryById,
	deleteMemory,
	listMemoriesByUserId,
	listMemoriesByUserIdPage,
} from './repo.ts'

function createMemoryDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE mcp_memories (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			category TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			subject TEXT NOT NULL,
			summary TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			source_uris_json TEXT NOT NULL DEFAULT '[]',
			dedupe_key TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_accessed_at TEXT,
			deleted_at TEXT
		)
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertMemory(
	sqlite: DatabaseSync,
	row: {
		id: string
		userId: string
		status: string
		subject: string
		deletedAt?: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
		)
		.run(
			row.id,
			row.userId,
			row.status,
			row.subject,
			row.subject,
			row.deletedAt ?? null,
		)
}

test('listMemoriesByUserIdPage is user-scoped, status-filtered, and keyset-paged', async () => {
	const { sqlite, db } = createMemoryDb()
	insertMemory(sqlite, {
		id: 'mem-a',
		userId: ownerIdFromStored('user-1'),
		status: 'active',
		subject: 'Owned active',
	})
	insertMemory(sqlite, {
		id: 'mem-b',
		userId: ownerIdFromStored('user-1'),
		status: 'deleted',
		subject: 'Owned deleted',
		deletedAt: '2026-01-02T00:00:00.000Z',
	})
	insertMemory(sqlite, {
		id: 'mem-c',
		userId: ownerIdFromStored('user-1'),
		status: 'archived',
		subject: 'Owned archived',
	})
	insertMemory(sqlite, {
		id: 'mem-other',
		userId: ownerIdFromStored('user-2'),
		status: 'active',
		subject: 'Foreign active',
	})

	const firstPage = await listMemoriesByUserIdPage({
		db,
		userId: ownerIdFromStored('user-1'),
		afterId: null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(firstPage.map((row) => row.id)).toEqual(['mem-a', 'mem-c'])
	expect(firstPage.every((row) => row.user_id === 'user-1')).toBe(true)

	const secondPage = await listMemoriesByUserIdPage({
		db,
		userId: ownerIdFromStored('user-1'),
		afterId: firstPage.at(-1)?.id ?? null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(secondPage).toEqual([])

	const withDeleted = await listMemoriesByUserIdPage({
		includeDeleted: true,
		db,
		userId: ownerIdFromStored('user-1'),
		afterId: null,
		limit: 10,
		statuses: ['active', 'archived', 'deleted'],
	})
	expect(withDeleted.map((row) => row.id)).toEqual(['mem-a', 'mem-b', 'mem-c'])
	expect(withDeleted.some((row) => row.user_id !== 'user-1')).toBe(false)
})

test('deleted memory reads require an explicit owner-scoped opt-in for list, detail, and export pages', async () => {
	const { sqlite, db } = createMemoryDb()
	const owner = ownerIdFromStored('owner')
	const foreign = ownerIdFromStored('foreign')
	for (const userId of [owner, foreign]) {
		insertMemory(sqlite, {
			id: `${userId}-live`,
			userId,
			status: 'active',
			subject: 'Live',
		})
		insertMemory(sqlite, {
			id: `${userId}-deleted`,
			userId,
			status: 'deleted',
			subject: 'Deleted',
			deletedAt: '2026-01-02T00:00:00.000Z',
		})
	}
	const statuses = ['active', 'archived', 'deleted'] as const
	for (const includeDeleted of [undefined, false, true]) {
		const expected = includeDeleted
			? ['owner-deleted', 'owner-live']
			: ['owner-live']
		const list = await listMemoriesByUserId(db, owner, {
			statuses: [...statuses],
			includeDeleted,
		})
		expect(list.map((row) => row.id).sort()).toEqual(expected)
		const page = await listMemoriesByUserIdPage({
			db,
			userId: owner,
			afterId: null,
			limit: 100,
			statuses: [...statuses],
			includeDeleted,
		})
		expect(page.map((row) => row.id)).toEqual(expected)
		const detail = await getMemoryById(db, owner, 'owner-deleted', {
			includeDeleted,
		})
		expect(detail?.id ?? null).toBe(includeDeleted ? 'owner-deleted' : null)
		expect(
			await getMemoryById(db, owner, 'foreign-deleted', { includeDeleted }),
		).toBeNull()
	}
	expect(await getMemoryById(db, owner, 'owner-deleted')).toBeNull()
	expect(await getMemoryById(db, owner, 'owner-live')).toMatchObject({
		id: 'owner-live',
	})
})

test('permanent deletion requires explicit force for deleted rows and remains owner scoped', async () => {
	const { sqlite, db } = createMemoryDb()
	const owner = ownerIdFromStored('owner')
	insertMemory(sqlite, {
		id: 'deleted',
		userId: owner,
		status: 'deleted',
		subject: 'Deleted',
		deletedAt: '2026-01-02T00:00:00.000Z',
	})
	insertMemory(sqlite, {
		id: 'live',
		userId: owner,
		status: 'active',
		subject: 'Live',
	})
	expect(await deleteMemory(db, owner, 'deleted')).toBe(false)
	expect(await deleteMemory(db, owner, 'deleted', { force: false })).toBe(false)
	expect(
		await deleteMemory(db, ownerIdFromStored('foreign'), 'deleted', {
			force: true,
		}),
	).toBe(false)
	expect(
		await getMemoryById(db, owner, 'deleted', { includeDeleted: true }),
	).not.toBeNull()
	expect(await deleteMemory(db, owner, 'deleted', { force: true })).toBe(true)
	expect(
		await getMemoryById(db, owner, 'deleted', { includeDeleted: true }),
	).toBeNull()
	expect(await deleteMemory(db, owner, 'live')).toBe(true)
})

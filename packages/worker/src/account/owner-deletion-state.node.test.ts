import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listOwnerIdsPendingDeletion } from './owner-deletion-state.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

const ts = '2026-01-01T00:00:00.000Z'

async function insertUser(
	db: D1Database,
	input: {
		stableUserId: string
		personalOrgId?: string
		deletingAt?: string
		deletedAt?: string
	},
) {
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				deleting_at, deleted_at
			) VALUES (?, ?, 'hash', ?, ?, ?, ?)`,
		)
		.bind(
			input.stableUserId,
			`${input.stableUserId}@example.com`,
			input.stableUserId,
			input.personalOrgId ?? null,
			input.deletingAt ?? null,
			input.deletedAt ?? null,
		)
		.run()
}

async function insertOrg(
	db: D1Database,
	input: { id: string; deletingAt?: string; deletedAt?: string },
) {
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, deleting_at,
				deleted_at, created_at, updated_at
			) VALUES (?, ?, ?, 'free', 'public', ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.id,
			input.id,
			input.deletingAt ?? null,
			input.deletedAt ?? null,
			ts,
			ts,
		)
		.run()
}

test('listOwnerIdsPendingDeletion finds person and org owners mid-deletion or deleted', async () => {
	const db = createDb()
	await insertUser(db, { stableUserId: 'person-live' })
	await insertUser(db, { stableUserId: 'person-legacy', deletingAt: ts })
	await insertUser(db, { stableUserId: 'person-soft', deletedAt: ts })
	// Owner id is a distinct personal org id; only the person row is fenced.
	await insertUser(db, {
		stableUserId: 'person-distinct',
		personalOrgId: 'org-personal-distinct',
		deletingAt: ts,
	})
	await insertOrg(db, { id: 'org-live' })
	await insertOrg(db, { id: 'org-deleting', deletingAt: ts })
	await insertOrg(db, { id: 'org-soft', deletedAt: ts })

	const pending = await listOwnerIdsPendingDeletion(db, [
		'person-live',
		'person-legacy',
		'person-soft',
		'org-personal-distinct',
		'org-live',
		'org-deleting',
		'org-soft',
		'unknown-owner',
		' ',
	])
	expect([...pending].sort()).toEqual([
		'org-deleting',
		'org-personal-distinct',
		'org-soft',
		'person-legacy',
		'person-soft',
	])
})

test('listOwnerIdsPendingDeletion chunks large owner lists under the D1 bind limit', async () => {
	const db = createDb()
	const owners = Array.from({ length: 75 }, (_, index) => `org-${index}`)
	for (const [index, id] of owners.entries()) {
		await insertOrg(db, index % 10 === 0 ? { id, deletingAt: ts } : { id })
	}
	const pending = await listOwnerIdsPendingDeletion(db, [...owners, ...owners])
	expect(pending.size).toBe(8)
	expect(await listOwnerIdsPendingDeletion(db, [])).toEqual(new Set())
})

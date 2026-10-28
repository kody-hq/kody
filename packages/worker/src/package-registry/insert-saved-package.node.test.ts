import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	insertSavedPackage,
	nextSavedPackageUpdatedAt,
	updateSavedPackage,
} from './repo.ts'

test('insertSavedPackage stamps the actor when package owner is a team org', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const actorUserId = personIdFromStored('member-1')
	const teamOrgOwnerId = ownerIdFromStored('acme-org')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('member', 'member@example.com', 'hash', ?)`,
		)
		.run(actorUserId)

	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const at = '2026-10-11T12:00:00.000Z'

	const stamped = await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: teamOrgOwnerId,
			name: '@acme/tool',
			description: 'Team tool',
			tags_json: '[]',
			search_text: null,
			source_id: sourceId,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: at,
			updated_at: at,
		},
		null,
		{ actorUserId },
	)

	expect(stamped).toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT first_saved_package_at FROM users WHERE stable_user_id = ?`,
			)
			.get(actorUserId),
	).toEqual({ first_saved_package_at: at })
})

test('insertSavedPackage falls back to row user_id when no actor is provided', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const ownerUserId = ownerIdFromStored('solo-user')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('solo', 'solo@example.com', 'hash', ?)`,
		)
		.run(ownerUserId)

	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const at = '2026-10-11T13:00:00.000Z'

	const stamped = await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@solo/pkg',
		description: 'Personal package',
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
		created_at: at,
		updated_at: at,
	})

	expect(stamped).toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT first_saved_package_at FROM users WHERE stable_user_id = ?`,
			)
			.get(ownerUserId),
	).toEqual({ first_saved_package_at: at })
})

test('insertSavedPackage derives kody_id from the name leaf and ignores a mismatched leftover', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const ownerUserId = ownerIdFromStored('leaf-user')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('leaf', 'leaf@example.com', 'hash', ?)`,
		)
		.run(ownerUserId)

	const packageId = crypto.randomUUID()
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@leaf/real-slug',
		kody_id: 'invented-second-id',
		description: 'Leaf wins',
		tags_json: '[]',
		search_text: null,
		source_id: crypto.randomUUID(),
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})

	expect(
		sqlite
			.prepare(`SELECT name, kody_id FROM saved_packages WHERE id = ?`)
			.get(packageId),
	).toEqual({ name: '@leaf/real-slug', kody_id: 'real-slug' })
})

test('updateSavedPackage keeps kody_id in lockstep with a renamed name leaf', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const ownerUserId = ownerIdFromStored('rename-user')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('rename', 'rename@example.com', 'hash', ?)`,
		)
		.run(ownerUserId)

	const packageId = crypto.randomUUID()
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@rename/before',
		description: 'Before',
		tags_json: '[]',
		search_text: null,
		source_id: crypto.randomUUID(),
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})

	await updateSavedPackage(db, {
		userId: ownerUserId,
		packageId,
		name: '@rename/after',
		description: 'After',
		audit: null,
	})

	expect(
		sqlite
			.prepare(
				`SELECT name, kody_id, description FROM saved_packages WHERE id = ?`,
			)
			.get(packageId),
	).toEqual({
		name: '@rename/after',
		kody_id: 'after',
		description: 'After',
	})
})

test('updateSavedPackage expectedUpdatedAt refuses a stale visibility write', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	const ownerUserId = ownerIdFromStored('cas-user')
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('cas', 'cas@example.com', 'hash', ?)`,
		)
		.run(ownerUserId)

	const packageId = crypto.randomUUID()
	const stampedAt = '2026-10-13T17:00:00.000Z'
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@cas/visibility',
		description: 'CAS',
		tags_json: '[]',
		search_text: null,
		source_id: crypto.randomUUID(),
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
		created_at: stampedAt,
		updated_at: stampedAt,
	})

	const cleared = await updateSavedPackage(db, {
		userId: ownerUserId,
		packageId,
		isInternetVisible: false,
		updatedAt: nextSavedPackageUpdatedAt(stampedAt),
		audit: null,
	})
	expect(cleared).toBe(true)
	expect(
		sqlite
			.prepare(`SELECT updated_at FROM saved_packages WHERE id = ?`)
			.get(packageId),
	).not.toEqual({ updated_at: stampedAt })

	const staleEnable = await updateSavedPackage(db, {
		userId: ownerUserId,
		packageId,
		isInternetVisible: true,
		expectedUpdatedAt: stampedAt,
		audit: null,
	})
	expect(staleEnable).toBe(false)

	expect(
		sqlite
			.prepare(`SELECT is_internet_visible FROM saved_packages WHERE id = ?`)
			.get(packageId),
	).toEqual({ is_internet_visible: 0 })
})

test('nextSavedPackageUpdatedAt advances past a same-ms stamp', () => {
	const stamp = '2026-10-13T17:00:00.000Z'
	expect(nextSavedPackageUpdatedAt(stamp) > stamp).toBe(true)
})

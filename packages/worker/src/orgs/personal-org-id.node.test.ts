import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	forgetPersonalOrgIdForPerson,
	loadPersonalOrgIdForPerson,
	personalOrgIdForPerson,
	personalOrgIdFromUserRow,
} from './personal-org-id.ts'

const personId = 'a'.repeat(64)
const distinctOrgId = 'b'.repeat(64)

test('personalOrgIdFromUserRow prefers a stored personal org id', () => {
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: distinctOrgId,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: `  ${distinctOrgId}  `,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
})

test('personalOrgIdFromUserRow falls back to the person id while the column is empty', () => {
	for (const personalOrgIdValue of [null, undefined, '', '   ']) {
		expect(
			personalOrgIdFromUserRow({
				personal_org_id: personalOrgIdValue,
				stable_user_id: `  ${personId}  `,
			}),
		).toBe(personId)
	}
})

test('personalOrgIdForPerson prefers a stamped personalOrgId', () => {
	const userId = personIdFromStored(personId)
	expect(
		personalOrgIdForPerson({
			userId,
			personalOrgId: distinctOrgId as never,
		}),
	).toBe(distinctOrgId)
	expect(personalOrgIdForPerson({ userId })).toBe(userId)
})

test('loadPersonalOrgIdForPerson reads users.personal_org_id', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const equalPerson = personIdFromStored('c'.repeat(64))
	const distinctPerson = personIdFromStored(personId)
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (1, 'equal', 'equal@example.com', 'x', ?, ?),
			        (2, 'distinct', 'distinct@example.com', 'x', ?, ?)`,
		)
		.bind(equalPerson, equalPerson, distinctPerson, distinctOrgId)
		.run()
	expect(await loadPersonalOrgIdForPerson(db, equalPerson)).toBe(equalPerson)
	expect(await loadPersonalOrgIdForPerson(db, distinctPerson)).toBe(
		distinctOrgId,
	)
	expect(
		await loadPersonalOrgIdForPerson(db, personIdFromStored('d'.repeat(64))),
	).toBe(personIdFromStored('d'.repeat(64)))
})

test('loadPersonalOrgIdForPerson shares one users read per person (KODY-AZ)', async () => {
	const queries: Array<string> = []
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite, { queries })
	const distinctPerson = personIdFromStored(personId)
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (1, 'distinct', 'distinct@example.com', 'x', ?, ?)`,
		)
		.bind(distinctPerson, distinctOrgId)
		.run()
	queries.length = 0

	const results = await Promise.all(
		Array.from({ length: 5 }, () =>
			loadPersonalOrgIdForPerson(db, distinctPerson),
		),
	)
	expect(results.every((id) => id === distinctOrgId)).toBe(true)
	expect(
		queries.filter((query) => query.toLowerCase().includes('from users')),
	).toHaveLength(1)

	await expect(loadPersonalOrgIdForPerson(db, distinctPerson)).resolves.toBe(
		distinctOrgId,
	)
	expect(
		queries.filter((query) => query.toLowerCase().includes('from users')),
	).toHaveLength(1)

	const convertedOrgId = 'e'.repeat(64)
	await db
		.prepare(`UPDATE users SET personal_org_id = ? WHERE stable_user_id = ?`)
		.bind(convertedOrgId, distinctPerson)
		.run()
	forgetPersonalOrgIdForPerson(db, distinctPerson)
	queries.length = 0
	await expect(loadPersonalOrgIdForPerson(db, distinctPerson)).resolves.toBe(
		convertedOrgId,
	)
	expect(
		queries.filter((query) => query.toLowerCase().includes('from users')),
	).toHaveLength(1)
})

import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	addOrgMember,
	createInvite,
	updateOrgMemberRole,
} from './access-writes.ts'
import {
	assertCompedSeatAvailable,
	CompedSeatLimitError,
	countLiveSeats,
} from './billing.ts'

const orgId = testStableUserIdFromEmail('comped-team@example.com')
const ownerId = testStableUserIdFromEmail('comped-owner@example.com')

function setup(input: {
	plan?: string
	stripePlan?: string | null
	compedSeats: number | null
	members?: number
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	sqlite
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, stripe_plan, comped_seats,
				created_at, updated_at
			) VALUES (?, 'comped', 'Comped', ?, ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(
			orgId,
			input.plan ?? 'pro',
			input.stripePlan ?? null,
			input.compedSeats,
		)
	insertMember(sqlite, ownerId, 'owner')
	for (let index = 0; index < (input.members ?? 0); index++) {
		insertMember(
			sqlite,
			testStableUserIdFromEmail(`existing-${index}@example.com`),
			'member',
		)
	}
	return { sqlite, db }
}

function insertUser(sqlite: DatabaseSync, userId: string) {
	sqlite
		.prepare(
			`INSERT OR IGNORE INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at
			) VALUES (?, ?, 'hash', ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(`u${userId.slice(0, 12)}`, `${userId}@example.com`, userId, userId)
}

function insertMember(sqlite: DatabaseSync, userId: string, role: string) {
	insertUser(sqlite, userId)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, '2026-01-01')`,
		)
		.run(orgId, userId, role)
}

function newPerson(sqlite: DatabaseSync, name: string) {
	const userId = testStableUserIdFromEmail(`${name}@example.com`)
	insertUser(sqlite, userId)
	return userId
}

function add(db: D1Database, userId: string, role: 'member' | 'billing') {
	return addOrgMember({
		db,
		orgId,
		userId,
		role,
		invitedByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
}

function liveRole(sqlite: DatabaseSync, userId: string) {
	return (
		sqlite
			.prepare(
				`SELECT role FROM org_memberships
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.get(orgId, userId) as { role: string } | undefined
	)?.role
}

test('a full comped seat cap refuses a new seat with a message for org admins', async () => {
	const { sqlite, db } = setup({ compedSeats: 2, members: 1 })
	const blocked = newPerson(sqlite, 'third')

	const error = await add(db, blocked, 'member').catch((caught) => caught)

	expect(error).toBeInstanceOf(CompedSeatLimitError)
	expect((error as Error).message).toBe(
		'This organization has used all 2 complimentary seats. An Owner or Admin can remove a member or move one to the Billing role to free a seat, or email support@kody.codes to ask for more seats.',
	)
	expect(liveRole(sqlite, blocked)).toBeUndefined()
	expect(await countLiveSeats(db, orgId)).toBe(2)
})

test('seats under the cap, Billing members, and live members are not blocked', async () => {
	const { sqlite, db } = setup({ compedSeats: 2 })
	const second = newPerson(sqlite, 'second')
	await add(db, second, 'member')
	expect(liveRole(sqlite, second)).toBe('member')

	const billing = newPerson(sqlite, 'billing')
	await add(db, billing, 'billing')
	expect(liveRole(sqlite, billing)).toBe('billing')

	await add(db, second, 'member')
	expect(await countLiveSeats(db, orgId)).toBe(2)
	await expect(
		assertCompedSeatAvailable(db, orgId, second),
	).resolves.toBeUndefined()
	await expect(assertCompedSeatAvailable(db, orgId)).rejects.toBeInstanceOf(
		CompedSeatLimitError,
	)
})

test('members already past a newly applied cap keep their seats; freeing seats reopens joins', async () => {
	const { sqlite, db } = setup({ compedSeats: 2, members: 3 })
	expect(await countLiveSeats(db, orgId)).toBe(4)
	await expect(
		add(db, newPerson(sqlite, 'late'), 'member'),
	).rejects.toBeInstanceOf(CompedSeatLimitError)

	const existing = testStableUserIdFromEmail('existing-0@example.com')
	await updateOrgMemberRole({
		db,
		orgId,
		userId: existing,
		role: 'admin',
		audit: createTestOrgAuditWriter(),
	})
	expect(liveRole(sqlite, existing)).toBe('admin')
	await updateOrgMemberRole({
		db,
		orgId,
		userId: existing,
		role: 'billing',
		audit: createTestOrgAuditWriter(),
	})
	expect(liveRole(sqlite, existing)).toBe('billing')
	await expect(
		updateOrgMemberRole({
			db,
			orgId,
			userId: existing,
			role: 'member',
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toBeInstanceOf(CompedSeatLimitError)
	expect(liveRole(sqlite, existing)).toBe('billing')

	sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = '2026-02-01'
			 WHERE org_id = ? AND user_id = ?`,
		)
		.run(orgId, testStableUserIdFromEmail('existing-1@example.com'))
	sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = '2026-02-01'
			 WHERE org_id = ? AND user_id = ?`,
		)
		.run(orgId, testStableUserIdFromEmail('existing-2@example.com'))
	await updateOrgMemberRole({
		db,
		orgId,
		userId: existing,
		role: 'member',
		audit: createTestOrgAuditWriter(),
	})
	expect(liveRole(sqlite, existing)).toBe('member')
})

test('seat invites are refused at creation when the cap is full; Billing invites are not', async () => {
	const { db } = setup({ compedSeats: 1 })
	const invite = (role: 'member' | 'billing') =>
		createInvite({
			db,
			orgId,
			kind: 'membership',
			role,
			inviteeEmail: `${role}-invitee@example.com`,
			invitedByUserId: ownerId,
			tokenHash: crypto.randomUUID(),
			audit: createTestOrgAuditWriter(),
		})

	await expect(invite('member')).rejects.toBeInstanceOf(CompedSeatLimitError)
	await expect(invite('billing')).resolves.toBeDefined()
})

test('no cap, a free manual plan, or a paid Stripe plan leaves seats unlimited', async () => {
	for (const options of [
		{ compedSeats: null },
		{ compedSeats: 1, plan: 'free' },
		{ compedSeats: 1, stripePlan: 'pro' },
	]) {
		const { sqlite, db } = setup(options)
		const joiner = newPerson(sqlite, 'joiner')
		await add(db, joiner, 'member')
		expect(liveRole(sqlite, joiner)).toBe('member')
	}
})

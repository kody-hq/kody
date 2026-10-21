import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import {
	assertCanAcceptFreeOrgOwnership,
	assertCanOwnAnotherFreeOrg,
	countLiveFreeOwnedOrgs,
	countLiveSeats,
	FreeOrgLimitError,
	isPaidOrg,
	listOrgBillingRecipientUserIds,
	readOrgBudgetSettings,
	readUserBudgetMicroUsd,
	resolveEffectiveUserBudgetMicroUsd,
} from './billing.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				id TEXT PRIMARY KEY NOT NULL,
				username TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				stable_user_id TEXT NOT NULL UNIQUE,
			personal_org_id TEXT,
				display_name TEXT,
				deleted_at TEXT
			)`,
		)
		.run()
	return db
}

const now = '2026-01-02T00:00:00.000Z'

async function insertOrg(
	db: D1Database,
	input: {
		id: string
		slug: string
		plan?: string
		defaultUserBudgetMicroUsd?: number | null
		automationBudgetMicroUsd?: number | null
	},
) {
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.slug,
			input.plan ?? 'free',
			now,
			now,
			input.defaultUserBudgetMicroUsd ?? null,
			input.automationBudgetMicroUsd ?? null,
		)
		.run()
}

async function insertMembership(
	db: D1Database,
	input: {
		orgId: string
		userId: string
		role: string
		deletedAt?: string | null
	},
) {
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(input.orgId, input.userId, input.role, now, input.deletedAt ?? null)
		.run()
}

test('isPaidOrg treats every non-free plan as paid', () => {
	expect(isPaidOrg('free')).toBe(false)
	expect(isPaidOrg('pro')).toBe(true)
	expect(isPaidOrg('standard')).toBe(true)
})

async function insertUser(
	db: D1Database,
	input: { email: string; deletedAt?: string | null },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	const username = input.email.split('@')[0] ?? input.email
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name, deleted_at)
			 VALUES (?, ?, ?, 'x', ?, ?, ?)`,
		)
		.bind(
			`user-${username}`,
			username,
			input.email,
			stableUserId,
			username,
			input.deletedAt ?? null,
		)
		.run()
	return stableUserId
}

test('countLiveSeats counts live owners and members but not billing or deleted people', async () => {
	const db = await createDb()
	const orgId = ownerIdFromStored('org-seats')
	const owner = await insertUser(db, { email: 'owner@example.com' })
	const member = await insertUser(db, { email: 'member@example.com' })
	const billing = await insertUser(db, { email: 'billing@example.com' })
	const gone = await insertUser(db, { email: 'gone@example.com' })
	const tombstoned = await insertUser(db, {
		email: 'tombstoned@example.com',
		deletedAt: now,
	})
	await insertOrg(db, { id: orgId, slug: 'seats-org' })
	await insertMembership(db, { orgId, userId: owner, role: 'owner' })
	await insertMembership(db, { orgId, userId: member, role: 'member' })
	await insertMembership(db, { orgId, userId: billing, role: 'billing' })
	await insertMembership(db, {
		orgId,
		userId: gone,
		role: 'member',
		deletedAt: now,
	})
	// A membership left behind on a deleted account must not bill a seat.
	await insertMembership(db, { orgId, userId: tombstoned, role: 'member' })

	expect(await countLiveSeats(db, orgId)).toBe(2)
})

test('listOrgBillingRecipientUserIds returns owners and billing role', async () => {
	const db = await createDb()
	const orgId = ownerIdFromStored('org-recipients')
	const owner = testStableUserIdFromEmail('owner2@example.com')
	const billing = testStableUserIdFromEmail('billing2@example.com')
	const member = testStableUserIdFromEmail('member2@example.com')
	await insertOrg(db, { id: orgId, slug: 'recipients' })
	await insertMembership(db, { orgId, userId: owner, role: 'owner' })
	await insertMembership(db, { orgId, userId: billing, role: 'billing' })
	await insertMembership(db, { orgId, userId: member, role: 'member' })

	const ids = await listOrgBillingRecipientUserIds(db, orgId)
	expect(ids.sort()).toEqual([billing, owner].sort())
})

test('assertCanAcceptFreeOrgOwnership enforces cap before new owner on free org', async () => {
	const db = await createDb()
	const userId = testStableUserIdFromEmail('invite-owner@example.com')
	await insertOrg(db, { id: 'free-1', slug: 'free-one' })
	await insertMembership(db, {
		orgId: ownerIdFromStored('free-1'),
		userId,
		role: 'owner',
	})
	await insertOrg(db, { id: 'free-2', slug: 'free-two' })
	await insertMembership(db, {
		orgId: ownerIdFromStored('free-2'),
		userId,
		role: 'owner',
	})
	await insertOrg(db, { id: 'free-3', slug: 'free-three' })

	await expect(
		assertCanAcceptFreeOrgOwnership({
			db,
			orgId: ownerIdFromStored('free-3'),
			userId,
		}),
	).rejects.toBeInstanceOf(FreeOrgLimitError)

	await insertOrg(db, { id: 'paid-invite', slug: 'paid', plan: 'pro' })
	await assertCanAcceptFreeOrgOwnership({
		db,
		orgId: ownerIdFromStored('paid-invite'),
		userId,
	})

	await assertCanAcceptFreeOrgOwnership({
		db,
		orgId: ownerIdFromStored('free-1'),
		userId,
	})
})

test('assertCanOwnAnotherFreeOrg enforces MAX_FREE_ORGS_PER_USER', async () => {
	const db = await createDb()
	const userId = testStableUserIdFromEmail('free-cap@example.com')
	await insertOrg(db, { id: 'free-1', slug: 'free-one' })
	await insertMembership(db, {
		orgId: ownerIdFromStored('free-1'),
		userId,
		role: 'owner',
	})
	await insertOrg(db, { id: 'free-2', slug: 'free-two' })
	await insertMembership(db, {
		orgId: ownerIdFromStored('free-2'),
		userId,
		role: 'owner',
	})

	expect(await countLiveFreeOwnedOrgs(db, userId)).toBe(2)

	await expect(assertCanOwnAnotherFreeOrg(db, userId)).rejects.toBeInstanceOf(
		FreeOrgLimitError,
	)
	await expect(assertCanOwnAnotherFreeOrg(db, userId)).rejects.toThrow(
		/2 free organizations/,
	)

	await insertOrg(db, { id: 'paid-1', slug: 'paid-one', plan: 'pro' })
	await insertMembership(db, {
		orgId: ownerIdFromStored('paid-1'),
		userId,
		role: 'owner',
	})
	expect(await countLiveFreeOwnedOrgs(db, userId)).toBe(2)
	await expect(assertCanOwnAnotherFreeOrg(db, userId)).rejects.toThrow()

	await db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.bind(now, 'free-1')
		.run()
	await assertCanOwnAnotherFreeOrg(db, userId)
})

test('resolveEffectiveUserBudgetMicroUsd prefers individual over org default', () => {
	expect(
		resolveEffectiveUserBudgetMicroUsd({
			individualBudget: 100,
			orgDefaultBudget: 200,
		}),
	).toBe(100)
	expect(
		resolveEffectiveUserBudgetMicroUsd({
			individualBudget: null,
			orgDefaultBudget: 200,
		}),
	).toBe(200)
	expect(
		resolveEffectiveUserBudgetMicroUsd({
			individualBudget: undefined,
			orgDefaultBudget: null,
		}),
	).toBeNull()
})

test('readOrgBudgetSettings and readUserBudgetMicroUsd read D1 rows', async () => {
	const db = await createDb()
	const orgId = ownerIdFromStored('org-budgets')
	const userId = testStableUserIdFromEmail('budget@example.com')
	await insertOrg(db, {
		id: orgId,
		slug: 'budget-org',
		defaultUserBudgetMicroUsd: 5_000_000,
		automationBudgetMicroUsd: 1_000_000,
	})

	expect(await readOrgBudgetSettings(db, orgId)).toEqual({
		defaultUserBudgetMicroUsd: 5_000_000,
		automationBudgetMicroUsd: 1_000_000,
	})

	await db
		.prepare(
			`INSERT INTO org_user_budgets (
				org_id, user_id, monthly_budget_micro_usd, set_by_user_id, updated_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(orgId, userId, 2_500_000, userId, now)
		.run()

	expect(await readUserBudgetMicroUsd(db, orgId, userId)).toBe(2_500_000)

	const settings = await readOrgBudgetSettings(db, orgId)
	expect(
		resolveEffectiveUserBudgetMicroUsd({
			individualBudget: await readUserBudgetMicroUsd(db, orgId, userId),
			orgDefaultBudget: settings.defaultUserBudgetMicroUsd,
		}),
	).toBe(2_500_000)
})

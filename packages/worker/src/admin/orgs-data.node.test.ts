import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	listAdminUserOrgMemberships,
	loadAdminOrgDetail,
	readAdminOrgsData,
} from './orgs-data.ts'
import {
	loadAdminUserByTarget,
	readAdminUsersData,
	updateAdminUserPlan,
} from './users-data.ts'

const ownerId = testStableUserIdFromEmail('owner@example.com')
const memberId = testStableUserIdFromEmail('member@example.com')
const billingId = testStableUserIdFromEmail('billing@example.com')
const deletedUserId = testStableUserIdFromEmail('deleted@example.com')
const teamId = testStableUserIdFromEmail('team-org@example.com')
const deletedTeamId = testStableUserIdFromEmail('archived-org@example.com')
const oldTeamId = testStableUserIdFromEmail('old-team@example.com')

function createOrgDataDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const seedUser = sqlite.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, deleted_at, deleting_at,
			created_at, updated_at
		) VALUES (?, ?, 'hash', ?, ?, ?, '2026-01-01', '2026-01-01')`,
	)
	seedUser.run('owner', 'owner@example.com', ownerId, null, null)
	seedUser.run('member', 'member@example.com', memberId, null, null)
	seedUser.run('billing', 'billing@example.com', billingId, null, null)
	seedUser.run(
		'deleted',
		'deleted@example.com',
		deletedUserId,
		'2026-01-04T00:00:00.000Z',
		'2026-01-03T00:00:00.000Z',
	)
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (
				id, slug, display_name, plan, stripe_plan, stripe_credits_eligible,
				admin_credits_eligible, default_user_budget_micro_usd,
				automation_budget_micro_usd, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
	)
	insertOrg.run(ownerId, 'owner', 'Owner', 'free', null, 0, 0, null, null)
	insertOrg.run(
		teamId,
		'blue-team',
		'Blue Team',
		'pro',
		'pro',
		1,
		0,
		1_000_000,
		2_000_000,
	)
	insertOrg.run(
		oldTeamId,
		'old-team',
		'Old Team',
		'standard',
		null,
		0,
		0,
		null,
		null,
	)
	sqlite
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, created_at, updated_at,
				deleted_at, deleting_at
			) VALUES (?, 'archived-team', 'Archived Team', 'standard',
				'2026-01-01', '2026-01-01', '2026-01-04T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z')`,
		)
		.run(deletedTeamId)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', '2026-01-01', NULL),
			        (?, ?, 'owner', '2026-01-01', NULL),
			        (?, ?, 'member', '2026-01-01', NULL),
			        (?, ?, 'billing', '2026-01-01', NULL),
			        (?, ?, 'member', '2026-01-01', NULL),
			        (?, ?, 'owner', '2026-01-01', '2026-01-02T00:00:00.000Z'),
			        (?, ?, 'owner', '2026-01-01', '2026-01-02T00:00:00.000Z')`,
		)
		.run(
			ownerId,
			ownerId,
			teamId,
			ownerId,
			teamId,
			memberId,
			teamId,
			billingId,
			teamId,
			deletedUserId,
			oldTeamId,
			ownerId,
			deletedTeamId,
			ownerId,
		)
	sqlite
		.prepare(
			`INSERT INTO org_user_budgets (
				org_id, user_id, monthly_budget_micro_usd, set_by_user_id, updated_at
			) VALUES (?, ?, 500000, ?, '2026-01-02')`,
		)
		.run(teamId, memberId, ownerId)
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-row', ?, 'engineering', 'Engineering', '2026-01-01', '2026-01-01')`,
		)
		.run(teamId)
	sqlite
		.prepare(
			`INSERT INTO credit_wallets (user_id, balance_micro_usd, created_at, updated_at)
			 VALUES (?, 3000000, '2026-01-01', '2026-01-01')`,
		)
		.run(teamId)
	sqlite
		.prepare(
			`INSERT INTO credit_ledger_entries (
				id, user_id, kind, amount_micro_usd, granted_by_user_id, note, created_at
			) VALUES ('grant-row', ?, 'admin_grant', 3000000, ?, 'fake fixture', '2026-01-02')`,
		)
		.run(teamId, ownerId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('organization list filters by state, kind, query, and live seat definition', async () => {
	const { db } = createOrgDataDb()
	const liveTeams = await readAdminOrgsData(db, {
		status: 'live',
		kind: 'team',
		query: 'BLUE',
		page: 1,
		pageSize: 20,
	})
	expect(liveTeams.items).toMatchObject([
		{ slug: 'blue-team', kind: 'team', effectivePlan: 'pro', seats: 2 },
	])
	expect(
		(
			await readAdminOrgsData(db, {
				status: 'deleted',
				kind: 'all',
				page: 1,
				pageSize: 20,
			})
		).items.map((org) => org.slug),
	).toEqual(['archived-team'])
	expect(
		(
			await readAdminOrgsData(db, {
				status: 'all',
				kind: 'personal',
				page: 1,
				pageSize: 20,
			})
		).items.map((org) => org.slug),
	).toEqual(['owner'])
	expect(
		(
			await readAdminOrgsData(db, {
				status: 'all',
				kind: 'all',
				page: 1,
				pageSize: 20,
			})
		).items.find((org) => org.slug === 'old-team')?.seats,
	).toBe(0)
	expect(
		(
			await readAdminOrgsData(db, {
				status: 'all',
				kind: 'all',
				page: 1,
				pageSize: 20,
			})
		).total,
	).toBe(4)
})

test('organization detail resolves slug/id, tombstone deadline, budgets, and org wallet', async () => {
	const { db } = createOrgDataDb()
	const detail = await loadAdminOrgDetail(db, { slug: '@blue-team' })
	expect(detail).toMatchObject({
		org: { id: teamId, slug: 'blue-team', kind: 'team' },
		seats: { live: 2, billingOnly: 1 },
		plan: {
			manualPlan: 'pro',
			stripePlan: 'pro',
			effectivePlan: 'pro',
			creditsEligible: true,
		},
		budgets: {
			defaultUserBudgetMicroUsd: 1_000_000,
			automationBudgetMicroUsd: 2_000_000,
		},
		wallet: {
			balanceMicroUsd: 3_000_000,
			recent: [
				{
					kind: 'admin_grant',
					amountMicroUsd: 3_000_000,
					grantedByUsername: 'owner',
				},
			],
		},
		teamsCount: 1,
	})
	expect(
		detail?.members.find((member) => member.stableUserId === memberId),
	).toMatchObject({
		individualBudgetMicroUsd: 500_000,
		effectiveBudgetMicroUsd: 500_000,
	})
	expect(
		detail?.members.find((member) => member.stableUserId === deletedUserId),
	).toMatchObject({
		username: 'deleted',
		userDeletedAt: '2026-01-04T00:00:00.000Z',
	})
	expect(await loadAdminOrgDetail(db, { orgId: teamId })).toMatchObject({
		org: { slug: 'blue-team' },
	})
	const deleted = await loadAdminOrgDetail(db, { slug: 'archived-team' })
	expect(deleted?.softDelete).toEqual({
		deletedAt: '2026-01-04T00:00:00.000Z',
		deletingAt: '2026-01-03T00:00:00.000Z',
		restoreDeadline: '2026-02-03T00:00:00.000Z',
	})
	expect(
		deleted?.members.find((member) => member.stableUserId === ownerId),
	).toMatchObject({
		membershipDeletedAt: '2026-01-02T00:00:00.000Z',
	})
})

test('user organization memberships include tombstones and sort personal first', async () => {
	const { db } = createOrgDataDb()
	const memberships = await listAdminUserOrgMemberships(db, ownerId)
	expect(memberships.map((item) => item.slug)).toEqual([
		'owner',
		'blue-team',
		'archived-team',
		'old-team',
	])
	expect(memberships).toHaveLength(4)
	expect(memberships[0]).toMatchObject({ kind: 'personal', role: 'owner' })
	expect(memberships[2]).toMatchObject({
		orgDeletedAt: '2026-01-04T00:00:00.000Z',
		membershipDeletedAt: '2026-01-02T00:00:00.000Z',
	})
	expect(memberships[3]?.membershipDeletedAt).toBe('2026-01-02T00:00:00.000Z')
})

test('deleted users are visible only in the deleted filter and remain unmutable', async () => {
	const { db } = createOrgDataDb()
	const env = { APP_DB: db } as Env
	const base = {
		query: '',
		role: null,
		verification: null,
		page: 1,
		pageSize: 20,
	}
	const live = await readAdminUsersData(env, { ...base, status: 'live' })
	const deleted = await readAdminUsersData(env, {
		...base,
		status: 'deleted',
		selectedStableUserId: deletedUserId,
	})
	expect(live.users.some((user) => user.stableUserId === deletedUserId)).toBe(
		false,
	)
	expect(deleted.users.map((user) => user.stableUserId)).toContain(
		deletedUserId,
	)
	expect(deleted.selectedUser?.deleted_at).toBe('2026-01-04T00:00:00.000Z')
	expect(
		(
			await readAdminUsersData(env, {
				...base,
				status: 'deleted',
				selectedStableUserId: ownerId,
			})
		).selectedUser,
	).toBeNull()
	expect(await loadAdminUserByTarget(db, { stableUserId: deletedUserId })).toBe(
		null,
	)
	expect(
		await updateAdminUserPlan(db, { stableUserId: deletedUserId, plan: 'pro' }),
	).toBeNull()
})

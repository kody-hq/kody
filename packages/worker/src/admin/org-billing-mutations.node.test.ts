import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { orgAuditWriterForPerson } from '#worker/orgs/org-audit.ts'
import {
	grantAdminCreditsToOrg,
	setAdminOrgCreditEligibility,
	setAdminOrgPlan,
} from './org-billing-mutations.ts'

const adminId = testStableUserIdFromEmail('admin@example.com')
const now = new Date('2026-11-01T00:00:00.000Z')

vi.unmock('#worker/audit-log.ts')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditSqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		auditSqlite,
		new URL('../../audit-migrations/', import.meta.url),
	)
	const auditDb = createD1FromSqlite(auditSqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		SENTRY_ENVIRONMENT: 'local',
	} as unknown as Env
	const audit = orgAuditWriterForPerson(env, {
		userId: adminId,
		username: 'admin',
	})
	return { sqlite, auditSqlite, env, audit }
}

function insertUser(
	sqlite: DatabaseSync,
	input: { email: string; username?: string; deletedAt?: string | null },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				deleted_at, created_at, updated_at
			) VALUES (?, ?, 'hash', ?, ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(
			input.username ?? input.email.split('@')[0],
			input.email,
			stableUserId,
			stableUserId,
			input.deletedAt ?? null,
		)
	return stableUserId
}

function insertOrg(
	sqlite: DatabaseSync,
	input: { id: string; slug: string; plan: string; deletedAt?: string | null },
) {
	sqlite
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, created_at, updated_at, deleted_at
			) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', ?)`,
		)
		.run(input.id, input.slug, input.slug, input.plan, input.deletedAt ?? null)
}

function addOwner(sqlite: DatabaseSync, orgId: string, userId: string) {
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01')`,
		)
		.run(orgId, userId)
}

function auditInput(
	env: Env,
	audit: ReturnType<typeof orgAuditWriterForPerson>,
) {
	return {
		env,
		audit,
		platformAudit: { email: 'admin@example.com', path: '/admin/orgs' },
		now,
	}
}

test('plan changes update plan and ladder and write both audits with the reason', async () => {
	const { sqlite, auditSqlite, env, audit } = createDb()
	const ownerId = insertUser(sqlite, { email: 'plan-owner@example.com' })
	const orgId = testStableUserIdFromEmail('plan-team@example.com')
	insertOrg(sqlite, { id: orgId, slug: 'plan-team', plan: 'free' })
	addOwner(sqlite, orgId, ownerId)

	const result = await setAdminOrgPlan({
		...auditInput(env, audit),
		target: { orgId },
		plan: 'pro',
		reason: 'Support approved a team plan.',
	})

	expect(result).toMatchObject({ previous: 'free', next: 'pro', changed: true })
	expect(
		sqlite
			.prepare(`SELECT plan, entitlement_ladder FROM orgs WHERE id = ?`)
			.get(orgId),
	).toMatchObject({ plan: 'pro', entitlement_ladder: expect.any(String) })
	const orgEvent = auditSqlite
		.prepare(
			`SELECT action, details_json FROM org_audit_events WHERE org_id = ?`,
		)
		.get(orgId) as { action: string; details_json: string }
	expect(orgEvent.action).toBe('admin_plan_set')
	expect(JSON.parse(orgEvent.details_json)).toMatchObject({
		previous: 'free',
		next: 'pro',
		reason: 'Support approved a team plan.',
	})
	expect(
		auditSqlite
			.prepare(
				`SELECT category, result, path, reason FROM audit_events WHERE action = 'adminOrgPlanSet'`,
			)
			.get(),
	).toMatchObject({
		category: 'admin',
		result: 'success',
		path: '/admin/orgs',
		reason: `org_id=${orgId};plan=pro;previous=free;reason=Support approved a team plan.`,
	})
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId },
			plan: 'pro',
			reason: 'No further plan change.',
		}),
	).resolves.toMatchObject({ changed: false, previous: 'pro', next: 'pro' })
	expect(
		auditSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM org_audit_events WHERE action = 'admin_plan_set'`,
			)
			.get(),
	).toMatchObject({ count: 1 })
	expect(
		auditSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM audit_events WHERE action = 'adminOrgPlanSet'`,
			)
			.get(),
	).toMatchObject({ count: 1 })
})

test('plan changes require a reason and refuse deleted organizations', async () => {
	const { sqlite, env, audit } = createDb()
	const orgId = testStableUserIdFromEmail('deleted-plan@example.com')
	insertOrg(sqlite, {
		id: orgId,
		slug: 'deleted-plan',
		plan: 'pro',
		deletedAt: '2026-10-01T00:00:00.000Z',
	})
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId },
			plan: 'max',
			reason: '   ',
		}),
	).rejects.toThrow('A reason is required.')
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId },
			plan: 'max',
			reason: 'Support approved.',
		}),
	).rejects.toThrow('Org not found.')
})

test('paid-to-free downgrade blocks owners at the cap but allows one free org', async () => {
	const { sqlite, env, audit } = createDb()
	const atCapOwner = insertUser(sqlite, { email: 'cap-owner@example.com' })
	const firstFree = testStableUserIdFromEmail('first-free@example.com')
	const paidOrg = testStableUserIdFromEmail('paid-team@example.com')
	insertOrg(sqlite, { id: atCapOwner, slug: 'cap-owner', plan: 'free' })
	insertOrg(sqlite, { id: firstFree, slug: 'first-free', plan: 'free' })
	insertOrg(sqlite, { id: paidOrg, slug: 'paid-team', plan: 'pro' })
	addOwner(sqlite, atCapOwner, atCapOwner)
	addOwner(sqlite, firstFree, atCapOwner)
	addOwner(sqlite, paidOrg, atCapOwner)

	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId: paidOrg },
			plan: 'free',
			reason: 'Downgrade requested.',
		}),
	).rejects.toThrow(
		'Downgrading this organization to free would give an Owner more than 2 free organizations. Make one of their organizations paid or delete one first.',
	)

	const underCapOwner = insertUser(sqlite, { email: 'under-cap@example.com' })
	const personalOrg = testStableUserIdFromEmail(
		'under-cap-personal@example.com',
	)
	const underCapPaid = testStableUserIdFromEmail('under-cap-team@example.com')
	insertOrg(sqlite, {
		id: personalOrg,
		slug: 'under-cap-personal',
		plan: 'free',
	})
	insertOrg(sqlite, { id: underCapPaid, slug: 'under-cap-team', plan: 'pro' })
	addOwner(sqlite, personalOrg, underCapOwner)
	addOwner(sqlite, underCapPaid, underCapOwner)
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId: underCapPaid },
			plan: 'free',
			reason: 'One free org already exists.',
		}),
	).resolves.toMatchObject({ previous: 'pro', next: 'free', changed: true })
})

test('billing-only memberships and deleted owners do not block downgrades; upgrades are allowed', async () => {
	const { sqlite, env, audit } = createDb()
	const billingOwner = insertUser(sqlite, { email: 'billing-cap@example.com' })
	const deletedOwner = insertUser(sqlite, {
		email: 'deleted-cap@example.com',
		deletedAt: '2026-10-01T00:00:00.000Z',
	})
	for (const [slug, id] of [
		[
			'billing-free-one',
			testStableUserIdFromEmail('billing-free-one@example.com'),
		],
		[
			'billing-free-two',
			testStableUserIdFromEmail('billing-free-two@example.com'),
		],
		[
			'deleted-free-one',
			testStableUserIdFromEmail('deleted-free-one@example.com'),
		],
		[
			'deleted-free-two',
			testStableUserIdFromEmail('deleted-free-two@example.com'),
		],
	] as const) {
		insertOrg(sqlite, { id, slug, plan: 'free' })
		addOwner(
			sqlite,
			id,
			slug.startsWith('billing') ? billingOwner : deletedOwner,
		)
	}
	const billingTarget = testStableUserIdFromEmail('billing-target@example.com')
	const deletedTarget = testStableUserIdFromEmail('deleted-target@example.com')
	const upgradeTarget = testStableUserIdFromEmail('upgrade-target@example.com')
	insertOrg(sqlite, { id: billingTarget, slug: 'billing-target', plan: 'pro' })
	insertOrg(sqlite, { id: deletedTarget, slug: 'deleted-target', plan: 'pro' })
	insertOrg(sqlite, { id: upgradeTarget, slug: 'upgrade-target', plan: 'free' })
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'billing', '2026-01-01'), (?, ?, 'owner', '2026-01-01'),
			        (?, ?, 'owner', '2026-01-01')`,
		)
		.run(
			billingTarget,
			billingOwner,
			deletedTarget,
			deletedOwner,
			upgradeTarget,
			billingOwner,
		)

	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId: billingTarget },
			plan: 'free',
			reason: 'Billing role does not count.',
		}),
	).resolves.toMatchObject({ changed: true })
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId: deletedTarget },
			plan: 'free',
			reason: 'Deleted owner does not count.',
		}),
	).resolves.toMatchObject({ changed: true })
	await expect(
		setAdminOrgPlan({
			...auditInput(env, audit),
			target: { orgId: upgradeTarget },
			plan: 'pro',
			reason: 'Upgrade is allowed.',
		}),
	).resolves.toMatchObject({ changed: true })
})

test('org credit grants are positive, reasoned, and written to both audit logs', async () => {
	const { sqlite, auditSqlite, env, audit } = createDb()
	const orgId = testStableUserIdFromEmail('credit-team@example.com')
	insertOrg(sqlite, { id: orgId, slug: 'credit-team', plan: 'pro' })
	const args = {
		...auditInput(env, audit),
		target: { orgId },
		grantedBy: { stableUserId: adminId, email: 'admin@example.com' },
		amountCents: 500,
		reason: 'Approved one-time team credit.',
	}
	const result = await grantAdminCreditsToOrg(args)
	expect(result).toMatchObject({ orgId, amountCents: 500 })
	expect(
		sqlite
			.prepare(
				`SELECT kind, amount_micro_usd, granted_by_user_id, note FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.get(orgId),
	).toMatchObject({
		kind: 'admin_grant',
		amount_micro_usd: 5_000_000,
		granted_by_user_id: adminId,
		note: args.reason,
	})
	const orgEvent = auditSqlite
		.prepare(
			`SELECT action, details_json FROM org_audit_events WHERE org_id = ?`,
		)
		.get(orgId) as { action: string; details_json: string }
	expect(orgEvent.action).toBe('admin_credits_granted')
	expect(JSON.parse(orgEvent.details_json)).toMatchObject({
		amountCents: 500,
		entryId: result.entryId,
		reason: args.reason,
	})
	expect(
		auditSqlite
			.prepare(
				`SELECT reason FROM audit_events WHERE action = 'adminOrgCreditGrant'`,
			)
			.get(),
	).toEqual({
		reason: `org_id=${orgId};amount_cents=500;entry_id=${result.entryId};reason=${args.reason}`,
	})
	await expect(
		grantAdminCreditsToOrg({ ...args, amountCents: 0 }),
	).rejects.toThrow(/./)
	await expect(
		grantAdminCreditsToOrg({ ...args, reason: '  ' }),
	).rejects.toThrow('A reason is required.')
})

test('org credit eligibility changes update the org and write both audits', async () => {
	const { sqlite, auditSqlite, env, audit } = createDb()
	const orgId = testStableUserIdFromEmail('eligible-team@example.com')
	insertOrg(sqlite, { id: orgId, slug: 'eligible-team', plan: 'pro' })
	const result = await setAdminOrgCreditEligibility({
		...auditInput(env, audit),
		target: { orgId },
		creditsEligible: true,
		reason: 'Enable the approved team wallet.',
	})
	expect(result).toMatchObject({ previous: false, next: true })
	expect(
		sqlite
			.prepare(`SELECT admin_credits_eligible FROM orgs WHERE id = ?`)
			.get(orgId),
	).toEqual({ admin_credits_eligible: 1 })
	expect(
		auditSqlite
			.prepare(
				`SELECT details_json FROM org_audit_events WHERE org_id = ? AND action = 'admin_credit_eligibility_set'`,
			)
			.get(orgId),
	).toMatchObject({
		details_json: expect.stringContaining('Enable the approved team wallet.'),
	})
	expect(
		auditSqlite
			.prepare(
				`SELECT reason FROM audit_events WHERE action = 'adminOrgCreditEligibilitySet'`,
			)
			.get(),
	).toEqual({
		reason: `org_id=${orgId};credits_eligible=true;previous=false;reason=Enable the approved team wallet.`,
	})
	const cleared = await setAdminOrgCreditEligibility({
		...auditInput(env, audit),
		target: { orgId },
		creditsEligible: false,
		reason: 'Hold the team wallet.',
	})
	expect(cleared).toMatchObject({ previous: true, next: false })
})

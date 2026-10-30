import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminOrgCreditEligibilitySetCapability } from './admin-org-credit-eligibility-set.ts'
import { adminOrgCreditGrantCapability } from './admin-org-credit-grant.ts'
import { adminOrgPlanSetCapability } from './admin-org-plan-set.ts'

vi.unmock('#worker/audit-log.ts')

function fixture() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditSqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		auditSqlite,
		new URL('../../../../audit-migrations/', import.meta.url),
	)
	const auditDb = createD1FromSqlite(auditSqlite)
	const adminId = testStableUserIdFromEmail('billing-admin@example.com')
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at
			) VALUES ('billingadmin', 'billing-admin@example.com', 'hash', ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(adminId, adminId)
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		SENTRY_ENVIRONMENT: 'local',
	} as unknown as Env
	const adminCaller = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(adminId),
			username: 'billingadmin',
			email: 'billing-admin@example.com',
			displayName: 'Billing Admin',
			roles: ['admin'],
		},
	})
	const userCaller = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(adminId),
			username: 'billingadmin',
			email: 'billing-admin@example.com',
			displayName: 'Billing Admin',
			roles: ['user'],
		},
	})
	return { sqlite, auditSqlite, env, adminId, adminCaller, userCaller }
}

function insertOrg(
	sqlite: DatabaseSync,
	id: string,
	slug: string,
	plan = 'free',
) {
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(id, slug, slug, plan)
}

test('org billing capabilities deny non-admins, audit successful mutations, and map cap failures', async () => {
	const { sqlite, auditSqlite, env, adminId, adminCaller, userCaller } =
		fixture()
	const capabilities = [
		adminOrgPlanSetCapability,
		adminOrgCreditGrantCapability,
		adminOrgCreditEligibilitySetCapability,
	]
	for (const capability of capabilities) {
		await expect(
			assertCallerCanAccessCapability(userCaller, capability),
		).rejects.toThrow('lacks required role "admin"')
		await assertCallerCanAccessCapability(adminCaller, capability)
	}

	const freeOne = testStableUserIdFromEmail('mcp-free-one@example.com')
	const freeTwo = testStableUserIdFromEmail('mcp-free-two@example.com')
	const ownerId = testStableUserIdFromEmail('mcp-owner@example.com')
	const paidOrg = testStableUserIdFromEmail('mcp-paid-team@example.com')
	const target = testStableUserIdFromEmail('mcp-target@example.com')
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id,
				created_at, updated_at
			) VALUES ('mcpowner', 'mcp-owner@example.com', 'hash', ?, ?, '2026-01-01', '2026-01-01')`,
		)
		.run(ownerId, ownerId)
	insertOrg(sqlite, ownerId, 'mcp-owner')
	insertOrg(sqlite, freeOne, 'mcp-free-one')
	insertOrg(sqlite, freeTwo, 'mcp-free-two')
	insertOrg(sqlite, paidOrg, 'mcp-paid-team', 'pro')
	insertOrg(sqlite, target, 'mcp-target')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01'), (?, ?, 'owner', '2026-01-01'),
			        (?, ?, 'owner', '2026-01-01'), (?, ?, 'owner', '2026-01-01')`,
		)
		.run(ownerId, ownerId, freeOne, ownerId, freeTwo, ownerId, paidOrg, ownerId)

	const ctx = { env, callerContext: adminCaller } as never
	await expect(
		adminOrgPlanSetCapability.handler(
			{
				orgId: paidOrg,
				plan: 'free',
				reason: 'MCP downgrade request.',
			},
			ctx,
		),
	).rejects.toBeInstanceOf(McpCallerError)
	const failedAudit = auditSqlite
		.prepare(
			`SELECT result, path FROM audit_events WHERE action = 'adminOrgPlanSet'`,
		)
		.get()
	expect(failedAudit).toEqual({ result: 'failure', path: '/mcp' })

	await adminOrgPlanSetCapability.handler(
		{ orgId: target, plan: 'pro', reason: 'MCP plan request.' },
		ctx,
	)
	const grant = await adminOrgCreditGrantCapability.handler(
		{
			orgId: target,
			amountCents: 100,
			reason: 'MCP credit request.',
		},
		ctx,
	)
	const eligibility = await adminOrgCreditEligibilitySetCapability.handler(
		{
			orgId: target,
			creditsEligible: true,
			reason: 'MCP eligibility request.',
		},
		ctx,
	)
	expect(grant).toMatchObject({ orgId: target, amountCents: 100 })
	expect(eligibility).toMatchObject({
		orgId: target,
		previous: false,
		next: true,
		changed: true,
	})
	const unchangedPlan = await adminOrgPlanSetCapability.handler(
		{ orgId: target, plan: 'pro', reason: 'MCP unchanged plan request.' },
		ctx,
	)
	const unchangedEligibility =
		await adminOrgCreditEligibilitySetCapability.handler(
			{
				orgId: target,
				creditsEligible: true,
				reason: 'MCP unchanged eligibility request.',
			},
			ctx,
		)
	expect(unchangedPlan).toMatchObject({ changed: false })
	expect(unchangedEligibility).toMatchObject({ changed: false })
	expect(
		auditSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM audit_events WHERE action IN (
					'adminOrgPlanSet', 'adminOrgCreditEligibilitySet'
				) AND result = 'success'`,
			)
			.get(),
	).toEqual({ count: 2 })
	expect(
		auditSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM org_audit_events WHERE org_id = ? AND action IN (
					'admin_plan_set', 'admin_credit_eligibility_set'
				)`,
			)
			.get(target),
	).toEqual({ count: 2 })
	expect(
		auditSqlite
			.prepare(
				`SELECT action, result, reason FROM audit_events WHERE action IN (
					'adminOrgPlanSet', 'adminOrgCreditGrant', 'adminOrgCreditEligibilitySet'
				) ORDER BY rowid DESC LIMIT 3`,
			)
			.all(),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				action: 'adminOrgPlanSet',
				result: 'success',
				reason: expect.stringContaining(';reason=MCP plan request.'),
			}),
			expect.objectContaining({
				action: 'adminOrgCreditGrant',
				result: 'success',
				reason: expect.stringContaining(';reason=MCP credit request.'),
			}),
			expect.objectContaining({
				action: 'adminOrgCreditEligibilitySet',
				result: 'success',
				reason: expect.stringContaining(';reason=MCP eligibility request.'),
			}),
		]),
	)
	expect(
		auditSqlite
			.prepare(`SELECT action FROM org_audit_events WHERE org_id = ?`)
			.all(target),
	).toEqual(
		expect.arrayContaining([
			{ action: 'admin_plan_set' },
			{ action: 'admin_credits_granted' },
			{ action: 'admin_credit_eligibility_set' },
		]),
	)
	void adminId
})

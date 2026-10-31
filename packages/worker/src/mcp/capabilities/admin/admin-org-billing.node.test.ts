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
import { adminCreditGrantCapability } from './admin-credit-grant.ts'
import { adminCreditEligibilitySetCapability } from './admin-credit-eligibility-set.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { buildSeatQuantityReport } from '#worker/billing/seat-quantity-report.ts'
import { adminOrgSeatQuantityReportCapability } from './admin-org-seat-quantity-report.ts'

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
		adminOrgSeatQuantityReportCapability,
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

test('legacy personal-org billing forwarders preserve outputs and audit once', async () => {
	const { sqlite, auditSqlite, env, adminId, adminCaller } = fixture()
	insertOrg(sqlite, adminId, 'billing-admin', 'pro')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01')`,
		)
		.run(adminId, adminId)
	const ctx = { env, callerContext: adminCaller } as never
	const grant = await adminCreditGrantCapability.handler(
		{
			stableUserId: adminId,
			amountCents: 125,
			reason: 'explicit grant reason',
		},
		ctx,
	)
	expect(grant).toMatchObject({
		amountCents: 125,
		wallet: { stableUserId: adminId },
	})
	expect(Object.keys(grant).sort()).toEqual([
		'amountCents',
		'entryId',
		'wallet',
	])
	const eligibility = await adminCreditEligibilitySetCapability.handler(
		{ stableUserId: adminId, creditsEligible: true },
		ctx,
	)
	expect(Object.keys(eligibility).sort()).toEqual([
		'previousAdminCreditsEligible',
		'wallet',
	])
	expect(
		auditSqlite
			.prepare(
				`SELECT action, reason FROM audit_events
				 WHERE action IN ('adminCreditGrant', 'adminCreditEligibilitySet')
				 AND result = 'success' ORDER BY rowid`,
			)
			.all(),
	).toEqual([
		{
			action: 'adminCreditGrant',
			reason: expect.stringContaining('reason=explicit grant reason'),
		},
		{
			action: 'adminCreditEligibilitySet',
			reason: expect.stringContaining(
				'No reason given (legacy adminCreditEligibilitySet)',
			),
		},
	])
	expect(
		auditSqlite
			.prepare(
				`SELECT action, org_id, details_json FROM org_audit_events
				 WHERE org_id = ? AND action IN ('admin_credits_granted', 'admin_credit_eligibility_set')
				 ORDER BY rowid`,
			)
			.all(adminId),
	).toHaveLength(2)
	const orgAuditDetails = auditSqlite
		.prepare(
			`SELECT action, details_json FROM org_audit_events
			 WHERE org_id = ? AND action IN ('admin_credits_granted', 'admin_credit_eligibility_set')
			 ORDER BY rowid`,
		)
		.all(adminId) as Array<{ action: string; details_json: string }>
	expect(orgAuditDetails.map((row) => JSON.parse(row.details_json))).toEqual([
		expect.objectContaining({ reason: 'explicit grant reason' }),
		expect.objectContaining({
			reason: 'No reason given (legacy adminCreditEligibilitySet)',
		}),
	])
	expect(
		auditSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM audit_events
				 WHERE action IN ('adminCreditGrant', 'adminCreditEligibilitySet')
				   AND result = 'success'`,
			)
			.get(),
	).toEqual({ count: 2 })
})

test('legacy adminUserUpdate maps a free-org cap block to McpCallerError', async () => {
	const { sqlite, env, adminId, adminCaller } = fixture()
	insertOrg(sqlite, adminId, 'billing-admin', 'pro')
	const freeOne = testStableUserIdFromEmail('legacy-cap-one@example.com')
	const freeTwo = testStableUserIdFromEmail('legacy-cap-two@example.com')
	insertOrg(sqlite, freeOne, 'legacy-cap-one')
	insertOrg(sqlite, freeTwo, 'legacy-cap-two')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01'), (?, ?, 'owner', '2026-01-01'),
			        (?, ?, 'owner', '2026-01-01')`,
		)
		.run(adminId, adminId, freeOne, adminId, freeTwo, adminId)
	await expect(
		adminUserUpdateCapability.handler({ stableUserId: adminId, plan: 'free' }, {
			env,
			callerContext: adminCaller,
		} as never),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('legacy credit forwarders preserve reason defaults and audit each call once', async () => {
	const { sqlite, auditSqlite, env, adminId, adminCaller } = fixture()
	insertOrg(sqlite, adminId, 'billing-admin', 'pro')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01')`,
		)
		.run(adminId, adminId)
	const ctx = { env, callerContext: adminCaller } as never
	const grant = await adminCreditGrantCapability.handler(
		{ stableUserId: adminId, amountCents: 50 },
		ctx,
	)
	const eligibility = await adminCreditEligibilitySetCapability.handler(
		{
			stableUserId: adminId,
			creditsEligible: true,
			reason: 'explicit eligibility reason',
		},
		ctx,
	)
	expect(Object.keys(grant).sort()).toEqual([
		'amountCents',
		'entryId',
		'wallet',
	])
	expect(Object.keys(eligibility).sort()).toEqual([
		'previousAdminCreditsEligible',
		'wallet',
	])
	const orgRows = auditSqlite
		.prepare(
			`SELECT org_id, action, details_json FROM org_audit_events
			 WHERE org_id = ? AND action IN ('admin_credits_granted', 'admin_credit_eligibility_set')
			 ORDER BY rowid`,
		)
		.all(adminId) as Array<{
		org_id: string
		action: string
		details_json: string
	}>
	expect(orgRows).toHaveLength(2)
	expect(orgRows.map((row) => JSON.parse(row.details_json))).toEqual([
		expect.objectContaining({
			reason: 'No reason given (legacy adminCreditGrant)',
		}),
		expect.objectContaining({ reason: 'explicit eligibility reason' }),
	])
	expect(
		auditSqlite
			.prepare(
				`SELECT action, result, reason FROM audit_events
				 WHERE action IN ('adminCreditGrant', 'adminCreditEligibilitySet')
				   AND result = 'success' ORDER BY rowid`,
			)
			.all(),
	).toEqual([
		expect.objectContaining({
			action: 'adminCreditGrant',
			result: 'success',
			reason: expect.stringContaining(
				'No reason given (legacy adminCreditGrant)',
			),
		}),
		expect.objectContaining({
			action: 'adminCreditEligibilitySet',
			result: 'success',
			reason: expect.stringContaining('reason=explicit eligibility reason'),
		}),
	])
})

test('legacy adminUserUpdate writes the personal-org audit reason once', async () => {
	const { sqlite, auditSqlite, env, adminId, adminCaller } = fixture()
	insertOrg(sqlite, adminId, 'billing-admin')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', '2026-01-01')`,
		)
		.run(adminId, adminId)
	const ctx = { env, callerContext: adminCaller } as never
	const explicit = await adminUserUpdateCapability.handler(
		{
			stableUserId: adminId,
			plan: 'pro',
			reason: 'explicit plan reason',
		},
		ctx,
	)
	const defaulted = await adminUserUpdateCapability.handler(
		{ stableUserId: adminId, plan: 'free' },
		ctx,
	)
	expect(Object.keys(explicit)).toEqual(['user'])
	expect(Object.keys(defaulted)).toEqual(['user'])
	const orgRows = auditSqlite
		.prepare(
			`SELECT org_id, details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'admin_plan_set' ORDER BY rowid`,
		)
		.all(adminId) as Array<{ org_id: string; details_json: string }>
	expect(orgRows).toHaveLength(2)
	expect(orgRows.map((row) => JSON.parse(row.details_json))).toEqual([
		expect.objectContaining({ reason: 'explicit plan reason' }),
		expect.objectContaining({
			reason: 'No reason given (legacy adminUserUpdate)',
		}),
	])
	expect(
		auditSqlite
			.prepare(
				`SELECT action, result, reason FROM audit_events
				 WHERE action = 'adminUserUpdate' ORDER BY rowid`,
			)
			.all(),
	).toEqual([
		expect.objectContaining({
			action: 'adminUserUpdate',
			result: 'success',
			reason: expect.stringContaining('reason=explicit plan reason'),
		}),
		expect.objectContaining({
			action: 'adminUserUpdate',
			result: 'success',
			reason: expect.stringContaining(
				'No reason given (legacy adminUserUpdate)',
			),
		}),
	])
})

test('seat report aggregates events and rejects Stripe checks without a key', async () => {
	const { auditSqlite, env } = fixture()
	for (const [id, previous, next] of [
		['fixture-org-a', 1, 3],
		['fixture-org-b', 1, 3],
		['fixture-org-c', 2, 3],
	] as const) {
		auditSqlite
			.prepare(
				`INSERT INTO org_audit_events
				 (id, org_id, action, result, details_json, created_at)
				 VALUES (?, ?, 'billing_seat_quantity_synced', 'success', ?, '2026-02-01T00:00:00.000Z')`,
			)
			.run(
				`event-${id}`,
				id,
				JSON.stringify({ previousQuantity: previous, nextQuantity: next }),
			)
	}
	const report = await buildSeatQuantityReport({
		db: env.APP_DB,
		env,
		since: '2026-01-01T00:00:00.000Z',
		checkStripe: false,
		limit: 100,
		offset: 0,
	})
	expect(report.syncs).toMatchObject({
		events: 3,
		orgs: 3,
		changes: [
			{ previousQuantity: 1, nextQuantity: 3, orgs: 2 },
			{ previousQuantity: 2, nextQuantity: 3, orgs: 1 },
		],
	})
	expect(JSON.stringify(report)).not.toContain('fixture-org-a')
	expect(JSON.stringify(report)).not.toContain('fixture-org-b')
	expect(JSON.stringify(report)).not.toContain('fixture-org-c')
	await expect(
		buildSeatQuantityReport({
			db: env.APP_DB,
			env,
			since: '2026-01-01T00:00:00.000Z',
			checkStripe: true,
			limit: 100,
			offset: 0,
		}),
	).rejects.toThrow('Stripe is not configured in this environment.')
})

test('seat report skips failed lookups, reads the seat item, and paginates without identifiers', async () => {
	const { sqlite, env } = fixture()
	const firstOrg = 'fixture-stripe-org-a'
	const secondOrg = 'fixture-stripe-org-b'
	const thirdOrg = 'fixture-stripe-org-c'
	for (const [orgId, slug, customerId] of [
		[firstOrg, 'fixture-stripe-slug-a', 'cus_fixture_a'],
		[secondOrg, 'fixture-stripe-slug-b', 'cus_fixture_b'],
		[thirdOrg, 'fixture-stripe-slug-c', 'cus_fixture_c'],
	] as const) {
		insertOrg(sqlite, orgId, slug, 'pro')
		sqlite
			.prepare(`UPDATE orgs SET stripe_customer_id = ? WHERE id = ?`)
			.run(customerId, orgId)
	}
	const fetchStub = vi.fn(
		async (request: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(request)
			if (url.includes('cus_fixture_a')) {
				return new Response(
					JSON.stringify({
						error: { message: 'Temporary Stripe lookup failure.' },
					}),
					{
						status: 500,
						headers: { 'content-type': 'application/json' },
					},
				)
			}
			if (url.includes('cus_fixture_b')) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: 'sub_fixture_b',
								status: 'active',
								cancel_at: null,
								items: {
									data: [
										{
											id: 'si_non_seat_b',
											quantity: 2,
											price: { id: 'price_other' },
										},
										{
											id: 'si_seat_b',
											quantity: 1,
											price: { id: 'price_pro' },
										},
									],
								},
							},
						],
					}),
					{ headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(
				JSON.stringify({
					data: [
						{
							id: 'sub_fixture_c',
							status: 'active',
							cancel_at: null,
							items: {
								data: [
									{
										id: 'si_fixture_c',
										quantity: 2,
										price: { id: 'price_pro' },
									},
								],
							},
						},
					],
				}),
				{ headers: { 'content-type': 'application/json' } },
			)
		},
	)
	vi.stubGlobal('fetch', fetchStub)
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const stripeEnv = {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_fixture',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as unknown as Env
	const firstPage = await buildSeatQuantityReport({
		db: env.APP_DB,
		env: stripeEnv,
		since: '2026-01-01T00:00:00.000Z',
		checkStripe: true,
		limit: 2,
		offset: 0,
	})
	expect(firstPage.stripe).toMatchObject({
		checked: 1,
		matching: 1,
		mismatched: 0,
		skipped: 1,
		nextOffset: 2,
	})
	const secondPage = await buildSeatQuantityReport({
		db: env.APP_DB,
		env: stripeEnv,
		since: '2026-01-01T00:00:00.000Z',
		checkStripe: true,
		limit: 2,
		offset: 2,
	})
	expect(secondPage.stripe).toMatchObject({
		checked: 1,
		matching: 0,
		mismatched: 1,
		skipped: 0,
		mismatches: [{ stripeQuantity: 2, liveSeats: 1, orgs: 1 }],
		nextOffset: null,
	})
	expect(fetchStub).toHaveBeenCalledTimes(3)
	expect(warnSpy).toHaveBeenCalledWith(
		'seat-quantity-report-stripe-lookup-failed',
		{ error: 'StripeApiError' },
	)
	expect(
		fetchStub.mock.calls.every(
			([, init]) => !init?.method || init.method === 'GET',
		),
	).toBe(true)
	const serialized = JSON.stringify({ firstPage, secondPage })
	for (const fixtureId of [
		firstOrg,
		secondOrg,
		thirdOrg,
		'fixture-stripe-slug-a',
		'fixture-stripe-slug-b',
		'fixture-stripe-slug-c',
		'cus_fixture_a',
		'cus_fixture_b',
		'cus_fixture_c',
	]) {
		expect(serialized).not.toContain(fixtureId)
	}
	expect(errorSpy).toHaveBeenCalledWith('stripe_api_error', {
		status: 500,
		path: '/v1/subscriptions',
	})
	vi.unstubAllGlobals()
	errorSpy.mockRestore()
	warnSpy.mockRestore()
})

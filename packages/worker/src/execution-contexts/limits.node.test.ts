import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { legacyPlanLimits, planLimits } from '#universal/plans.ts'
import {
	buildExecutionContextLimitMessage,
	executionContextOrgLimit,
} from '#worker/entitlements/errors.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countLiveOwnedContexts,
	insertExecutionContext,
	listOrgExecutionContextsPage,
	type ExecutionContextListPosition,
} from './store.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

let serial = 0
function row(input: { orgId: string; operator: string; name?: string }) {
	serial += 1
	return {
		id: `ec_${serial}`,
		org_id: input.orgId,
		operator_user_id: input.operator,
		name: input.name ?? `box-${serial}`,
		public_key_jwk: '{}',
		thumbprint: `thumb_${serial}`,
		created_at: '2026-11-26T00:00:00.000Z',
		client_name: '@kodycodes/cli',
		client_version: '1.0.0',
		capabilities_json: '{}',
		grant_json: null,
		grant_version: 1,
	}
}

test('plan limits: Free 10, Standard and Pro 20, Max 50 per seat', () => {
	expect(planLimits.free.maxExecutionContextsPerSeat).toBe(10)
	expect(planLimits.standard.maxExecutionContextsPerSeat).toBe(20)
	expect(planLimits.pro.maxExecutionContextsPerSeat).toBe(20)
	expect(planLimits.max.maxExecutionContextsPerSeat).toBe(50)
	expect(legacyPlanLimits.standard.maxExecutionContextsPerSeat).toBe(20)
	expect(legacyPlanLimits.pro.maxExecutionContextsPerSeat).toBe(20)
})

test('the org cap pools seats on paid plans and is one pool on Free', () => {
	expect(
		executionContextOrgLimit({ plan: 'free', perSeat: 10, seats: 4 }),
	).toBe(10)
	expect(executionContextOrgLimit({ plan: 'pro', perSeat: 20, seats: 2 })).toBe(
		40,
	)
	expect(executionContextOrgLimit({ plan: 'max', perSeat: 50, seats: 0 })).toBe(
		50,
	)
})

test('the per-seat cap refuses a registration past the operator limit', async () => {
	const { db } = setup()
	const caps = { perOperator: 2, perOrg: 10 }
	const org = 'org_seat'
	expect(
		await insertExecutionContext(db, row({ orgId: org, operator: 'u1' }), caps),
	).toBe(true)
	expect(
		await insertExecutionContext(db, row({ orgId: org, operator: 'u1' }), caps),
	).toBe(true)
	expect(
		await insertExecutionContext(db, row({ orgId: org, operator: 'u1' }), caps),
	).toBe(false)
	expect(
		await insertExecutionContext(db, row({ orgId: org, operator: 'u2' }), caps),
	).toBe(true)
	expect(
		await countLiveOwnedContexts(db, { orgId: org, operatorUserId: 'u1' }),
	).toEqual({
		org: 3,
		operator: 2,
	})
})

test('the per-org cap refuses once the pooled total is reached', async () => {
	const { db } = setup()
	const caps = { perOperator: 5, perOrg: 3 }
	const org = 'org_pool'
	for (const operator of ['u1', 'u2', 'u3']) {
		expect(
			await insertExecutionContext(db, row({ orgId: org, operator }), caps),
		).toBe(true)
	}
	expect(
		await insertExecutionContext(db, row({ orgId: org, operator: 'u4' }), caps),
	).toBe(false)
})

test('revoked rows and attachments do not count toward either cap', async () => {
	const { sqlite, db } = setup()
	const caps = { perOperator: 1, perOrg: 1 }
	const revoked = row({ orgId: 'org_a', operator: 'u1' })
	expect(await insertExecutionContext(db, revoked, caps)).toBe(true)
	sqlite.exec(
		`UPDATE execution_contexts SET revoked_at = '2026-11-26' WHERE id = '${revoked.id}'`,
	)
	const elsewhere = row({ orgId: 'org_b', operator: 'u1' })
	expect(await insertExecutionContext(db, elsewhere, caps)).toBe(true)
	sqlite.exec(
		`INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, created_at)
		 VALUES ('${elsewhere.id}', 'org_a', 'u1', '2026-11-26')`,
	)
	expect(
		await insertExecutionContext(
			db,
			row({ orgId: 'org_a', operator: 'u1' }),
			caps,
		),
	).toBe(true)
})

test('limit messages name the cap, how it is made, and the next step', () => {
	const base = { orgSlug: 'acme', current: 40 }
	expect(
		buildExecutionContextLimitMessage({
			...base,
			scope: 'org',
			plan: 'pro',
			perSeat: 20,
			seats: 2,
		}),
	).toBe(
		'Kody plan limit reached for @acme: your "pro" plan allows at most 40 live execution contexts in this organization (20 per seat x 2 seats) and the organization has 40. Revoke an unused context with `kody context revoke <name>` or on the execution contexts page at /@acme/-/execution-contexts, or upgrade your plan at /@acme/-/billing.',
	)
	const seat = buildExecutionContextLimitMessage({
		...base,
		current: 10,
		scope: 'seat',
		plan: 'free',
		perSeat: 10,
		seats: 1,
	})
	expect(seat).toContain('at most 10 live execution contexts per person')
	expect(seat).toContain('you have registered 10')
	const max = buildExecutionContextLimitMessage({
		...base,
		current: 50,
		scope: 'seat',
		plan: 'max',
		perSeat: 50,
		seats: 3,
	})
	expect(max).toContain('contact support')
	expect(max).not.toContain('upgrade')
})

test('keyset pages walk owned and attached contexts by name without repeats', async () => {
	const { sqlite, db } = setup()
	const caps = { perOperator: 100, perOrg: 100 }
	for (let index = 0; index < 23; index++) {
		await insertExecutionContext(
			db,
			row({
				orgId: 'org_p',
				operator: 'u1',
				name: `n-${String(index).padStart(2, '0')}`,
			}),
			caps,
		)
	}
	const attached = row({ orgId: 'org_q', operator: 'u2', name: 'n-05' })
	await insertExecutionContext(db, attached, caps)
	sqlite.exec(
		`INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, created_at)
		 VALUES ('${attached.id}', 'org_p', 'u2', '2026-11-26')`,
	)
	const seen: Array<string> = []
	let after: ExecutionContextListPosition | null = null
	const sizes: Array<number> = []
	for (;;) {
		const page = await listOrgExecutionContextsPage(db, {
			orgId: 'org_p',
			after,
			limit: 10,
		})
		sizes.push(page.length)
		seen.push(...page.map((context) => context.id))
		if (page.length < 10) break
		after = page.at(-1)!
	}
	expect(sizes).toEqual([10, 10, 4])
	expect(new Set(seen).size).toBe(24)
	expect(seen).toContain(attached.id)
})

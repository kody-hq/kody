import { env } from 'cloudflare:workers'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureEntitlementTestSchema } from './test-schema.ts'
import {
	assertWithinComputeInclude,
	consumeDailyEntitlement,
	consumeExecuteUniqueWorkerDay,
} from './service.ts'
import { BudgetLimitError } from './errors.ts'
import {
	orgBudgetForJobExecution,
	recordOrgBudgetSpend,
	syncOrgBudgetSpendFromCreditLedger,
} from './budget-gate.ts'
import {
	checkUserMeterBudgetAndRecord,
	userMeterRpc,
} from './user-meter-client.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const now = new Date('2026-03-15T12:00:00.000Z')
const month = utcMonthKey(now)

async function seedBudgetOrg(input: {
	prefix: string
	userBudgetMicroUsd: number | null
	automationBudgetMicroUsd: number | null
}) {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	const email = `${input.prefix}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const suffix = crypto.randomUUID().slice(0, 8)
	const slug = `acme-${suffix}`
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `budget-${suffix}`,
		plan: 'free',
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'free', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				slug = excluded.slug,
				default_user_budget_micro_usd = excluded.default_user_budget_micro_usd,
				automation_budget_micro_usd = excluded.automation_budget_micro_usd`,
	)
		.bind(
			userId,
			slug,
			now.toISOString(),
			now.toISOString(),
			input.userBudgetMicroUsd,
			input.automationBudgetMicroUsd,
		)
		.run()
	return { email, userId, slug, orgId: ownerIdFromStored(userId) }
}

function catchError(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(caught: unknown) => caught,
	)
}

const samOverBudget = (slug: string) =>
	`@sam reached their monthly budget in org @${slug} ($50.00 of $50.00). An org Owner or Billing member can raise it.`
const automationOverBudget = (slug: string) =>
	`Automation in org @${slug} reached its monthly budget. An org Owner or Billing member can raise it.`

async function seedSamAtBudget() {
	const seeded = await seedBudgetOrg({
		prefix: 'budget-gate',
		userBudgetMicroUsd: 50_000_000,
		automationBudgetMicroUsd: null,
	})
	await checkUserMeterBudgetAndRecord({
		env,
		userId: seeded.orgId,
		check: {
			month,
			actorUserId: seeded.userId,
			automationSource: null,
			deltaMicroUsd: 50_000_000,
			userBudgetMicroUsd: 50_000_000,
			automationBudgetMicroUsd: null,
			actorUsername: 'sam',
			orgSlug: seeded.slug,
		},
	})
	return seeded
}

function expectSamDenial(error: unknown, slug: string) {
	expect(error).toBeInstanceOf(BudgetLimitError)
	expect((error as BudgetLimitError).message).toBe(samOverBudget(slug))
	expect((error as BudgetLimitError).details).toEqual({
		code: 'org_budget_limit_exceeded',
		kind: 'user',
		orgSlug: slug,
		actorUsername: 'sam',
		spentMicroUsd: 50_000_000,
		budgetMicroUsd: 50_000_000,
	})
}

test('over user budget denies a new execute worker via consumeExecuteUniqueWorkerDay', async () => {
	const { email, userId, slug, orgId } = await seedSamAtBudget()
	const error = await catchError(
		consumeExecuteUniqueWorkerDay({
			db: env.APP_DB,
			env,
			userId: orgId,
			email,
			workerId: 'kody-budget-gate',
			now,
			orgBudget: {
				orgId,
				orgSlug: slug,
				actorUserId: userId,
				actorUsername: 'sam',
			},
		}),
	)
	expectSamDenial(error, slug)
	const state = await userMeterRpc({ env, userId: orgId }).getBudgetSpend({
		month,
	})
	expect(state.users[userId]).toBe(50_000_000)
})

test('over user budget denies package app compute via assertWithinComputeInclude', async () => {
	const { userId, slug, orgId } = await seedSamAtBudget()
	const error = await catchError(
		assertWithinComputeInclude({
			db: env.APP_DB,
			env,
			userId: orgId,
			now,
			orgBudget: {
				orgId,
				orgSlug: slug,
				actorUserId: userId,
				actorUsername: 'sam',
			},
		}),
	)
	expectSamDenial(error, slug)
})

test('over automation budget denies scheduled job runs via consumeDailyEntitlement', async () => {
	const { email, slug, orgId } = await seedBudgetOrg({
		prefix: 'budget-automation',
		userBudgetMicroUsd: null,
		automationBudgetMicroUsd: 1_000_000,
	})
	await checkUserMeterBudgetAndRecord({
		env,
		userId: orgId,
		check: {
			month,
			actorUserId: null,
			automationSource: 'schedule',
			deltaMicroUsd: 1_000_000,
			userBudgetMicroUsd: null,
			automationBudgetMicroUsd: 1_000_000,
			orgSlug: slug,
		},
	})
	const orgBudget = orgBudgetForJobExecution({
		orgId,
		orgSlug: slug,
		source: { kind: 'schedule', jobId: 'job-1' },
	})
	const error = await catchError(
		consumeDailyEntitlement({
			db: env.APP_DB,
			env,
			userId: orgId,
			email,
			resource: 'job_runs_per_day',
			now,
			orgBudget,
		}),
	)
	expect(error).toBeInstanceOf(BudgetLimitError)
	expect((error as BudgetLimitError).message).toBe(automationOverBudget(slug))
	expect((error as BudgetLimitError).details).toEqual({
		code: 'org_budget_limit_exceeded',
		kind: 'automation',
		orgSlug: slug,
		spentMicroUsd: 1_000_000,
		budgetMicroUsd: 1_000_000,
	})
	const executeError = await catchError(
		consumeExecuteUniqueWorkerDay({
			db: env.APP_DB,
			env,
			userId: orgId,
			email,
			workerId: 'kody-budget-automation',
			now,
			orgBudget,
		}),
	)
	expect((executeError as BudgetLimitError).message).toBe(
		automationOverBudget(slug),
	)
	const state = await userMeterRpc({ env, userId: orgId }).getBudgetSpend({
		month,
	})
	expect(state.automationMicroUsd).toBe(1_000_000)
})

test('recordOrgBudgetSpend records the live month without a limit check', async () => {
	const { userId, slug, orgId } = await seedSamAtBudget()
	await recordOrgBudgetSpend({
		db: env.APP_DB,
		env,
		orgId,
		orgSlug: slug,
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 5_000_000,
		now,
	})
	const state = await userMeterRpc({ env, userId: orgId }).getBudgetSpend({
		month,
	})
	expect(state.users[userId]).toBe(55_000_000)
})

test('recordOrgBudgetSpend skips past-month debits without resetting live MTD', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	const email = `past-month-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const orgId = userId
	const april = new Date('2026-04-10T12:00:00.000Z')
	const march = '2026-03'
	await seedAccount({
		db: env.APP_DB,
		email,
		username: 'april-user',
		plan: 'free',
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'free', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug`,
	)
		.bind(
			orgId,
			'april-org',
			april.toISOString(),
			april.toISOString(),
			null,
			null,
		)
		.run()
	const meter = userMeterRpc({ env, userId: ownerIdFromStored(orgId) })
	await checkUserMeterBudgetAndRecord({
		env,
		userId: ownerIdFromStored(orgId),
		check: {
			month: utcMonthKey(april),
			actorUserId: userId,
			automationSource: null,
			deltaMicroUsd: 10_000_000,
			userBudgetMicroUsd: 50_000_000,
			automationBudgetMicroUsd: null,
			actorUsername: 'april-user',
			orgSlug: 'april-org',
		},
	})
	await recordOrgBudgetSpend({
		db: env.APP_DB,
		env,
		orgId: ownerIdFromStored(orgId),
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 5_000_000,
		now: april,
		month: march,
	})
	const state = await meter.getBudgetSpend({ month: utcMonthKey(april) })
	expect(state.users[userId]).toBe(10_000_000)
})

test('syncOrgBudgetSpendFromCreditLedger recovers MTD from ledger and weights overage only', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureCreditWalletTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS usage_attribution_daily (
			user_id TEXT NOT NULL,
			day TEXT NOT NULL,
			package_id TEXT NOT NULL,
			meter TEXT NOT NULL,
			units REAL NOT NULL DEFAULT 0,
			actor_user_id TEXT,
			automation_source TEXT,
			PRIMARY KEY (user_id, day, package_id, meter)
		)`,
	).run()
	const email = `sync-budget-${crypto.randomUUID()}@example.com`
	const orgId = testStableUserIdFromEmail(email)
	const memberA = testStableUserIdFromEmail(`a-${email}`)
	const memberB = testStableUserIdFromEmail(`b-${email}`)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: 'sync-owner',
		plan: 'pro',
		stableUserId: orgId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'pro', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug`,
	)
		.bind(orgId, 'sync-org', now.toISOString(), now.toISOString(), null, null)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO usage_attribution_daily
			(user_id, day, package_id, meter, units, actor_user_id, automation_source)
		 VALUES
			(?, '2026-03-01', 'pkg', 'unique_worker_days', 10, ?, NULL),
			(?, '2026-03-02', 'pkg', 'unique_worker_days', 5, ?, NULL)`,
	)
		.bind(orgId, memberA, orgId, memberB)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO credit_ledger_entries
			(id, user_id, kind, amount_micro_usd, meter, month, units, created_at)
		 VALUES (?, ?, 'debit', ?, 'unique_worker_days', ?, ?, ?)`,
	)
		.bind(
			`debit:${orgId}:${month}:unique_worker_days:0`,
			orgId,
			-20_000,
			month,
			5,
			now.toISOString(),
		)
		.run()

	await syncOrgBudgetSpendFromCreditLedger({
		db: env.APP_DB,
		env,
		orgId: ownerIdFromStored(orgId),
		month,
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		now,
	})
	const meter = userMeterRpc({ env, userId: ownerIdFromStored(orgId) })
	const first = await meter.getBudgetSpend({ month })
	expect(first.users[memberA] ?? 0).toBe(0)
	expect(first.users[memberB]).toBe(20_000)

	// Idempotent replay must not double-count.
	await syncOrgBudgetSpendFromCreditLedger({
		db: env.APP_DB,
		env,
		orgId: ownerIdFromStored(orgId),
		month,
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		now,
	})
	const second = await meter.getBudgetSpend({ month })
	expect(second.users[memberB]).toBe(20_000)
	expect(second.users[orgId] ?? 0).toBe(0)

	// Absolute replace clears a prior org-fallback row when member shares appear.
	await meter.replaceBudgetSpendFromLedger({
		month,
		users: { [orgId]: 20_000 },
		automation: 0,
	})
	await syncOrgBudgetSpendFromCreditLedger({
		db: env.APP_DB,
		env,
		orgId: ownerIdFromStored(orgId),
		month,
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		now,
	})
	const third = await meter.getBudgetSpend({ month })
	expect(third.users[orgId] ?? 0).toBe(0)
	expect(third.users[memberB]).toBe(20_000)

	// Ledger replace must overwrite provisional estimate rows even when lower.
	await checkUserMeterBudgetAndRecord({
		env,
		userId: ownerIdFromStored(orgId),
		check: {
			month,
			actorUserId: memberB,
			automationSource: null,
			deltaMicroUsd: 50_000,
			userBudgetMicroUsd: 1_000_000,
			automationBudgetMicroUsd: null,
		},
	})
	await meter.replaceBudgetSpendFromLedger({
		month,
		users: { [memberB]: 20_000 },
		automation: 0,
	})
	const afterEstimate = await meter.getBudgetSpend({ month })
	expect(afterEstimate.users[memberB]).toBe(20_000)
})

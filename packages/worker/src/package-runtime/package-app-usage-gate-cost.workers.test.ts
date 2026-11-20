import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { env } from 'cloudflare:test'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test, vi } from 'vitest'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { assertWithinComputeInclude } from '#worker/entitlements/service.ts'
import { isComputeOverageLimitError } from '#worker/entitlements/errors.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createCountingD1 } from '#worker/test-support/counting-d1.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	gatePackageAppUsage,
	packageAppUsageBreakerCooldownMs,
} from './package-app-usage-breaker.ts'

/**
 * D1 statements the package-app usage check puts on a request's critical
 * path: blocking `assertWithinComputeInclude` (before the breaker) vs the
 * breaker's closed and open states, over real local D1 and KV.
 */

const now = new Date()

async function seedProOwner(label: string, workerDays: number) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(username, email, 'hash', now.toISOString(), stableUserId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: 'free',
		stripeCustomerId: null,
		stripePlan: 'pro',
		stripeCreditsEligible: 1,
		createdAt: now.toISOString(),
	})
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, 'dynamic_worker_day', ?, ?)`,
	)
		.bind(stableUserId, utcMonthKey(now), workerDays)
		.run()
	return { ownerId: ownerIdFromStored(stableUserId), username }
}

function usageCheck(input: {
	db: D1Database
	ownerId: ReturnType<typeof ownerIdFromStored>
	username: string
}) {
	return () =>
		assertWithinComputeInclude({
			db: input.db,
			env,
			userId: input.ownerId,
			orgBudget: {
				orgId: input.ownerId,
				orgSlug: input.username,
				actorUserId: input.ownerId,
				actorUsername: input.username,
			},
		})
}

test('the usage check leaves the critical path: 0 blocking D1 statements while closed or open', async () => {
	resetIsolateState()
	const within = await seedProOwner('usage-gate-within', 10)
	const counting = createCountingD1(env.APP_DB)
	const check = usageCheck({ db: counting.db, ...within })

	// Before: the check blocked every request.
	await check()
	const coldStatements = counting.statements.length
	counting.reset()
	await check()
	const warmStatements = counting.statements.length
	expect(coldStatements).toBeGreaterThan(0)

	// After, closed: the request resolves before the check runs.
	resetIsolateState()
	counting.reset()
	const deferred: Array<Promise<unknown>> = []
	await gatePackageAppUsage({
		env,
		ownerId: within.ownerId,
		actorId: within.ownerId,
		check,
		waitUntil: (promise) => deferred.push(promise),
	})
	const closedBlockingStatements = counting.statements.length
	await Promise.all(deferred)
	expect(closedBlockingStatements).toBe(0)
	expect(counting.statements.length).toBe(warmStatements)

	expect({
		before: { coldStatements, warmStatements },
		afterClosed: {
			blockingStatements: closedBlockingStatements,
			deferredStatements: counting.statements.length,
		},
	}).toEqual({
		before: { coldStatements: 9, warmStatements: 4 },
		afterClosed: { blockingStatements: 0, deferredStatements: 4 },
	})
})

test('past the include: the first request is served, then the breaker refuses from KV with no D1', async () => {
	resetIsolateState()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	const past = await seedProOwner('usage-gate-past', 351)
	const counting = createCountingD1(env.APP_DB)
	const check = usageCheck({ db: counting.db, ...past })
	const deferred: Array<Promise<unknown>> = []
	const gate = (at: number) =>
		gatePackageAppUsage({
			env,
			ownerId: past.ownerId,
			actorId: past.ownerId,
			check,
			waitUntil: (promise) => deferred.push(promise),
			now: at,
		})
	const start = Date.now()

	await expect(gate(start)).resolves.toBeUndefined()
	await Promise.all(deferred.splice(0))

	// A fresh isolate sees the KV deny entry.
	resetIsolateState()
	counting.reset()
	const refused = await gate(start + 1_000).catch((error: unknown) => error)
	expect(isComputeOverageLimitError(refused)).toBe(true)
	expect(counting.statements).toEqual([])

	// Half-open: the probe runs the check, which still denies, and re-opens.
	const probe = await gate(start + packageAppUsageBreakerCooldownMs).catch(
		(error: unknown) => error,
	)
	expect(isComputeOverageLimitError(probe)).toBe(true)
	expect(counting.statements.length).toBeGreaterThan(0)
	vi.restoreAllMocks()
})

import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	loadAccountCreditsUser,
	loadAccountUsageCredits,
} from '#app/account-credits-data.ts'
import { loadAccountUsageStory } from '#app/account-usage-story.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import { applyCreditPayment } from '#worker/billing/credit-wallet.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const now = new Date('2026-09-27T12:00:00.000Z')
const month = utcMonthKey(now)
const overHundredPercent = /\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/

async function seedUser(input: {
	label: string
	stripePlan?: string | null
	creditsEligible?: boolean
}) {
	const email = `${input.label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `${input.label}-${crypto.randomUUID().slice(0, 8)}`
	const result = await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: 'free',
		stripeCustomerId: input.creditsEligible
			? `cus_${crypto.randomUUID()}`
			: null,
		stripePlan: input.stripePlan ?? null,
		stripeCreditsEligible: input.creditsEligible ? 1 : 0,
		createdAt: now.toISOString(),
	})
	return { id: Number(result.meta.last_row_id), stableUserId }
}

async function setRollups(userId: string, counts: Record<string, number>) {
	for (const [metric, count] of Object.entries(counts)) {
		await env.APP_DB.prepare(
			`INSERT INTO usage_rollups (user_id, metric, month, event_count)
			 VALUES (?, ?, ?, ?)`,
		)
			.bind(userId, metric, month, count)
			.run()
	}
}

/**
 * The story + Credits half of `loadAccountUsageData` (the entitlement
 * snapshot needs tables this suite does not migrate).
 */
async function loadStoryAndCredits(userId: number) {
	const row = await env.APP_DB.prepare(
		`SELECT stable_user_id FROM users WHERE id = ?`,
	)
		.bind(userId)
		.first<{ stable_user_id: string }>()
	if (!row) throw new Error('seeded user missing')
	const user = await loadAccountCreditsUser({
		env,
		userId,
		orgId: row.stable_user_id,
		personal: true,
		now,
	})
	if (!user) throw new Error('seeded user missing')
	const computeOverage = await readAccountComputeOverage({
		db: env.APP_DB,
		stableUserId: user.stableUserId,
		plan: user.entitlement.plan,
		ladder: user.entitlement.ladder,
		creditWallet: user.entitlement.creditWallet,
		now,
	})
	const { credits, wallet } = await loadAccountUsageCredits({
		env,
		stableUserId: user.stableUserId,
		entitlement: user.entitlement,
		canBuyCredits: user.canBuyCredits,
		hasPaidProSubscription: user.canBuyCredits,
		computeOverage,
		now,
		billingHref: '/@usage/-/billing',
	})
	const story = await loadAccountUsageStory({
		db: env.APP_DB,
		stableUserId: user.stableUserId,
		plan: user.entitlement.plan,
		creditWallet: user.entitlement.creditWallet,
		canBuyCredits: user.canBuyCredits,
		hasPaidProSubscription: user.canBuyCredits,
		computeOverage,
		now,
		...(wallet ? { wallet } : {}),
	})
	return { ...story, credits }
}

test('usage story and Credits section on real D1: Free calm, funded Pro on credits, empty Pro stopped', async () => {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const free = await seedUser({ label: 'story-free' })
	const funded = await seedUser({
		label: 'story-funded',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const empty = await seedUser({
		label: 'story-empty',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	await setRollups(free.stableUserId, {
		execute: 140,
		job_run: 2,
		dynamic_worker_day: 517,
	})
	await setRollups(funded.stableUserId, {
		execute: 4_812,
		job_run: 96,
		workflow_run: 12,
		package_export: 310,
		dynamic_worker_day: 43_768,
	})
	await setRollups(empty.stableUserId, {
		execute: 900,
		dynamic_worker_day: 400,
	})
	await applyCreditPayment({
		db: env.APP_DB,
		userId: funded.stableUserId,
		kind: 'top_up',
		amountCents: 50_000,
		stripeReference: `cs_${crypto.randomUUID()}`,
		paymentMethodId: 'pm_saved',
		now,
	})

	const freeData = await loadStoryAndCredits(free.id)
	expect(freeData?.credits?.eligible).toBe(false)
	expect(freeData?.creditsAlarm).toBeNull()
	expect(freeData?.activity.metrics[0]).toEqual({
		metric: 'execute',
		label: 'Code executions',
		count: 140,
	})
	expect(freeData?.includedCompute[0]).toMatchObject({
		resource: 'unique_worker_days',
		current: 517,
		informational: true,
		barPercent: 0,
		tone: 'calm',
	})

	const fundedData = await loadStoryAndCredits(funded.id)
	expect(fundedData?.credits).toMatchObject({
		eligible: true,
		hasCredits: true,
		balanceMicroUsd: 500_000_000,
	})
	expect(fundedData?.creditsAlarm).toBeNull()
	expect(
		fundedData?.activity.metrics.map((item) => [item.metric, item.count]),
	).toEqual([
		['execute', 4_812],
		['job_run', 96],
		['workflow_run', 12],
		['package_export', 310],
	])
	expect(fundedData?.includedCompute[0]).toMatchObject({
		current: 43_768,
		include: 350,
		barPercent: 100,
		tone: 'calm',
		onCreditsMicroUsd: 173_672_000,
		status: 'Include used · $173.67 on credits',
	})

	const emptyData = await loadStoryAndCredits(empty.id)
	expect(emptyData?.credits).toMatchObject({
		eligible: true,
		hasCredits: false,
	})
	expect(emptyData?.creditsAlarm).toMatchObject({
		kind: 'include_used_no_credits',
		tone: 'warn',
	})
	expect(emptyData?.includedCompute[0]).toMatchObject({
		barPercent: 100,
		tone: 'attention',
	})

	for (const data of [freeData, fundedData, emptyData]) {
		expect(
			JSON.stringify([
				data?.includedCompute,
				data?.includedComputeSummary,
				data?.creditsAlarm,
			]),
		).not.toMatch(overHundredPercent)
	}
})

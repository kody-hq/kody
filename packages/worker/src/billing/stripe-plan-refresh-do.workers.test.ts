import { expect, test, vi, type Mock } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	scheduleStripePlanRefreshBackstop,
	stripePlanRefreshBackstopDelayMs,
} from './stripe-plan-refresh-client.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function stubFetch<T extends Mock>(fetchMock: T) {
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

async function seedStripeRefreshUser(prefix: string, stripeCustomerId: string) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const username = `${prefix}-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, 'test-password-hash', ?, ?)`,
	)
		.bind(username, email, new Date().toISOString(), userId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: 'free',
		stripeCustomerId,
	})
	const stub = env.STRIPE_PLAN_REFRESH.get(
		env.STRIPE_PLAN_REFRESH.idFromName(userId),
	)
	return {
		userId,
		stub,
		readAlarm: () =>
			runInDurableObject(stub, async (_instance, state) =>
				state.storage.getAlarm(),
			),
		fireAlarmNow: () =>
			runInDurableObject(stub, async (instance: DurableObject, state) => {
				await state.storage.deleteAlarm()
				if (!instance.alarm) throw new Error('StripePlanRefresh has no alarm()')
				await instance.alarm()
			}),
	}
}

test('plan-relevant activity arms a per-user alarm that refreshes Stripe once', async () => {
	const { userId, readAlarm, fireAlarmNow } = await seedStripeRefreshUser(
		'stripe-alarm',
		'cus_alarm',
	)
	const now = new Date('2026-08-01T06:00:00.000Z')

	const scheduledBetween = Date.now()
	await expect(
		scheduleStripePlanRefreshBackstop({
			env,
			userId: ownerIdFromStored(userId),
			now,
		}),
	).resolves.toBe(true)
	const alarmAt = await readAlarm()
	expect(alarmAt).toBeTypeOf('number')
	expect(alarmAt).toBeGreaterThanOrEqual(
		scheduledBetween + stripePlanRefreshBackstopDelayMs,
	)
	expect(alarmAt).toBeLessThanOrEqual(
		Date.now() + stripePlanRefreshBackstopDelayMs,
	)

	using fetchStub = stubFetch(
		vi.fn(async () =>
			Response.json({
				data: [
					{
						id: 'sub_alarm',
						status: 'active',
						cancel_at: null,
						items: { data: [{ price: { id: 'price_pro' } }] },
					},
				],
			}),
		),
	)
	await fireAlarmNow()

	const row = await env.APP_DB.prepare(
		`SELECT stripe_plan, stripe_plan_refreshed_at
		 FROM orgs
		 WHERE id = ?`,
	)
		.bind(userId)
		.first<{
			stripe_plan: string | null
			stripe_plan_refreshed_at: string | null
		}>()
	expect(row?.stripe_plan).toBe('pro')
	expect(row?.stripe_plan_refreshed_at).toBeTruthy()
	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(await readAlarm()).toBeNull()
})

test('refresh failures re-arm, while account deletion prevents re-arming after purge', async () => {
	const { userId, stub, readAlarm, fireAlarmNow } = await seedStripeRefreshUser(
		'stripe-alarm-retry',
		'cus_alarm_retry',
	)
	await scheduleStripePlanRefreshBackstop({
		env,
		userId: ownerIdFromStored(userId),
	})
	consoleError.mockImplementation(() => {})
	using _fetch = stubFetch(
		vi.fn(async () => Response.json({ error: 'stripe down' }, { status: 500 })),
	)

	const retryScheduledAfter = Date.now()
	await fireAlarmNow()
	expect(await readAlarm()).toBeGreaterThanOrEqual(
		retryScheduledAfter + stripePlanRefreshBackstopDelayMs,
	)
	expect(consoleError).toHaveBeenCalledWith(
		'stripe_plan_refresh_alarm_failed',
		expect.objectContaining({ userId, error: expect.any(Error) }),
	)

	await stub.purgeUser({ userId })
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	await expect(
		scheduleStripePlanRefreshBackstop({
			env,
			userId: ownerIdFromStored(userId),
		}),
	).resolves.toBe(false)
	expect(await readAlarm()).toBeNull()
})

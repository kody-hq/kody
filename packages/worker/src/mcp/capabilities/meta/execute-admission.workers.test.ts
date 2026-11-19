import { env, runInDurableObject } from 'cloudflare:test'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import type { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	walletGuardPlanLimits,
	walletGuardWindowMs,
} from '#universal/wallet-guards.ts'
import { executeCapability } from './execute.ts'

async function seedCaller() {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `execute-capability-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `execute-cap-${crypto.randomUUID().slice(0, 8)}`
	const createdAt = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(username, email, 'test-password-hash', createdAt, stableUserId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: 'free',
		stripeCustomerId: null,
		stripePlan: null,
		stripeCreditsEligible: 0,
		createdAt,
	})
	return {
		ownerId: ownerIdFromStored(stableUserId),
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.dev',
			user: {
				userId: personIdFromStored(stableUserId),
				email,
				displayName: username,
			},
		}),
	}
}

test('the execute capability is refused at the daily execute ceiling before it starts a run', async () => {
	consoleWarn.mockImplementation(() => {})
	const { ownerId, callerContext } = await seedCaller()
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(ownerId)),
	)
	const dayMs = walletGuardWindowMs.day
	await runInDurableObject(stub, async (_instance: UserMeter, state) => {
		state.storage.sql.exec(
			`INSERT INTO wallet_guard_windows (bucket, window_start, count)
			VALUES (?, ?, ?)`,
			'org:execute_calls_per_day',
			Math.floor(Date.now() / dayMs) * dayMs,
			walletGuardPlanLimits.maxExecuteCallsPerDay,
		)
	})

	await expect(
		executeCapability.handler(
			{ code: 'export default async function main() { return 1 }' },
			{ env, callerContext },
		),
	).rejects.toMatchObject({
		name: 'WalletGuardLimitError',
		details: {
			guard: 'execute',
			limitKey: 'execute_calls_per_day',
			scope: 'org',
			limit: 120_000,
			support: 'support@kody.codes',
		},
	})
})

test('an admitted execute capability call runs and counts against the daily execute ceiling', async () => {
	// The sandbox bundler warns that it is experimental.
	consoleWarn.mockImplementation(() => {})
	const { ownerId, callerContext } = await seedCaller()
	const result = await executeCapability.handler(
		{ code: 'export default async function main() { return 1 }' },
		{ env, callerContext },
	)
	expect(result).toMatchObject({ ok: true, result: 1 })

	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(ownerId)),
	)
	const counted = await runInDurableObject(
		stub,
		async (_instance: UserMeter, state) =>
			state.storage.sql
				.exec<{ count: number }>(
					`SELECT count FROM wallet_guard_windows WHERE bucket = ?`,
					'org:execute_calls_per_day',
				)
				.toArray()[0]?.count,
	)
	expect(Number(counted)).toBe(1)
})

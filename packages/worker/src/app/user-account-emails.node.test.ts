import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as cloudflareEmail from '#app/email/cloudflare-email.ts'

const sendCloudflareEmail = vi.fn<typeof cloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const { readUsageCampaign } = await import('#worker/usage/campaign-ledger.ts')

const {
	sendBillingSuccessEmail,
	sendConnectAgentEmail,
	sendPastDueEmail,
	sendPaymentFailedEmail,
	userAccountEmailKvKey,
} = await import('#app/user-account-emails.ts')

/** 30-day KV claim TTL — public contract for once-per-kind sends. */
const accountEmailClaimTtlSeconds = 30 * 24 * 60 * 60

function createKv() {
	const store = new Map<string, string>()
	const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = []
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) => {
			puts.push({ key, options })
			store.set(key, value)
		},
		delete: async (key: string) => {
			store.delete(key)
		},
	}
	return { store, puts, kv }
}

function createEnv(
	kv?: ReturnType<typeof createKv>['kv'],
	overrides: Record<string, unknown> = {},
) {
	return {
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		COOKIE_SECRET: 'account-email-test-cookie-secret',
		BUNDLE_ARTIFACTS_KV: kv,
		...overrides,
	} as unknown as Env
}

function createAppDb(stableUserId: string) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('ada', 'ada@example.com', 'x', ?)`,
		)
		.run(stableUserId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function connectAgent(env: Env, userId: string) {
	return sendConnectAgentEmail({ env, email: 'ada@example.com', userId })
}

test('account emails claim once per kind and skip when KV or sender is missing', async () => {
	expect(await connectAgent(createEnv(), 'user-1')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv, store, puts } = createKv()
	const env = createEnv(kv)
	expect(await connectAgent(env, 'user-1')).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		html: string
		text: string
	}
	expect(payload.to).toBe('ada@example.com')
	expect(payload.html).toContain('https://kody.codes/onboarding')
	expect(payload.text).toContain('https://kody.codes/onboarding')
	expect(payload.text).toContain('/unsubscribe/tips?token=')
	expect(
		store.get(
			userAccountEmailKvKey({
				userId: ownerIdFromStored('user-1'),
				kind: 'connect_agent',
			}),
		),
	).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(accountEmailClaimTtlSeconds)

	sendCloudflareEmail.mockClear()
	expect(await connectAgent(env, 'user-1')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const user = {
		env,
		email: 'ada@example.com',
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
	}
	expect(await sendBillingSuccessEmail({ ...user, planLabel: 'Pro' })).toBe(
		true,
	)
	expect(await sendPaymentFailedEmail({ ...user, day: '2026-08-29' })).toBe(
		true,
	)
	expect(await sendPastDueEmail({ ...user, day: '2026-08-29' })).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(3)
})

test('connect-agent mail does not claim when unsubscribe minting fails, and opens an event campaign row for the sweep', async () => {
	const { db } = createAppDb('user-open')
	const { kv, store } = createKv()
	const env = createEnv(kv, { APP_DB: db, COOKIE_SECRET: '' })
	consoleWarn.mockImplementation(() => {})

	expect(await connectAgent(env, 'user-open')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(
		store.get(
			userAccountEmailKvKey({
				userId: ownerIdFromStored('user-open'),
				kind: 'connect_agent',
			}),
		),
	).toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'connect-agent-unsubscribe-mint-failed',
		expect.any(Error),
	)
	expect(await readUsageCampaign(db, 'user-open')).toMatchObject({
		state: 'VerifiedNoMcp',
		origin: 'event',
		send_count: 0,
	})
})

test('connect-agent mail skips when the user opted out of Kody tips', async () => {
	const { sqlite, db } = createAppDb('user-1')
	sqlite.exec(
		`INSERT INTO user_tips_email_opt_outs (user_id, opted_out_at)
		 VALUES ('user-1', '2026-09-06T00:00:00.000Z')`,
	)
	const env = createEnv(createKv().kv, { APP_DB: db })
	expect(await connectAgent(env, 'user-1')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('account emails reserve the KV claim before sending and release it on send failure', async () => {
	const { kv, store } = createKv()
	const order: Array<string> = []
	const originalPut = kv.put
	kv.put = async (...args) => {
		order.push('put')
		return originalPut(...args)
	}
	sendCloudflareEmail.mockImplementation(async () => {
		order.push('send')
		return { ok: true }
	})
	const env = createEnv(kv)

	expect(await connectAgent(env, 'user-claim')).toBe(true)
	expect(order).toEqual(['put', 'send'])

	sendCloudflareEmail.mockImplementation(async () => {
		throw new Error('smtp down')
	})
	consoleWarn.mockImplementation(() => {})
	expect(
		await sendBillingSuccessEmail({
			env,
			email: 'ada@example.com',
			userId: ownerIdFromStored('user-claim'),
			orgSlug: 'ada',
			planLabel: 'Pro',
		}),
	).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith('user-account-email-send-failed', {
		kind: 'billing_success',
		error: expect.any(Error),
	})
	expect(
		store.get(
			userAccountEmailKvKey({
				userId: ownerIdFromStored('user-claim'),
				kind: 'billing_success',
				suffix: 'pro',
			}),
		),
	).toBeUndefined()
})

test('connect-agent mail sends from the verify request origin when no sending domain is set', async () => {
	sendCloudflareEmail.mockClear()
	const { kv } = createKv()
	const env = createEnv(kv, {
		APP_BASE_URL: '',
		SYSTEM_EMAIL_DOMAIN: '',
	})
	expect(
		await sendConnectAgentEmail({
			env,
			email: 'ada@example.com',
			userId: ownerIdFromStored('user-request'),
			requestUrl: 'http://127.0.0.1:3847/verify-email?token=abc',
		}),
	).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ from: 'kody@127.0.0.1' }),
	)
})

test('connect-agent mail opens the retry row when no sender can be resolved', async () => {
	sendCloudflareEmail.mockClear()
	const { db } = createAppDb('user-noconfig')
	const { kv } = createKv()
	const env = createEnv(kv, {
		APP_DB: db,
		APP_BASE_URL: '',
		SYSTEM_EMAIL_DOMAIN: '',
	})
	expect(
		await sendConnectAgentEmail({
			env,
			email: 'ada@example.com',
			userId: ownerIdFromStored('user-noconfig'),
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await readUsageCampaign(db, 'user-noconfig')).toMatchObject({
		state: 'VerifiedNoMcp',
		origin: 'event',
		send_count: 0,
	})
})

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
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

const {
	sendBillingSuccessEmail,
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

function billingSuccess(env: Env, userId: string) {
	return sendBillingSuccessEmail({
		env,
		email: 'ada@example.com',
		userId: ownerIdFromStored(userId),
		orgSlug: 'ada',
		planLabel: 'Pro',
	})
}

test('account emails claim once per kind and skip when KV or sender is missing', async () => {
	expect(await billingSuccess(createEnv(), 'user-1')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv, store, puts } = createKv()
	const env = createEnv(kv)
	expect(await billingSuccess(env, 'user-1')).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const userId = ownerIdFromStored('user-1')
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		subject: string
		html: string
		text: string
	}
	expect(payload.to).toBe('ada@example.com')
	expect(payload.subject).toBe("You're on Kody Pro")
	expect(payload.html).toContain('Welcome to Pro')
	expect(payload.text).toContain('/@ada/-/billing')
	expect(
		store.get(`account-email-user:v1:${userId}:billing_success:pro`),
	).toEqual(expect.stringMatching(/^\d+$/))
	expect(puts[0]?.key).toBe(
		`account-email-user:v1:${userId}:billing_success:pro`,
	)
	expect(puts[0]?.options?.expirationTtl).toBe(accountEmailClaimTtlSeconds)

	sendCloudflareEmail.mockClear()
	expect(await billingSuccess(env, 'user-1')).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const user = {
		env,
		email: 'ada@example.com',
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
	}
	expect(await sendPaymentFailedEmail({ ...user, day: '2026-08-29' })).toBe(
		true,
	)
	expect(await sendPastDueEmail({ ...user, day: '2026-08-29' })).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(2)
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

	expect(
		await sendPastDueEmail({
			env,
			email: 'ada@example.com',
			userId: ownerIdFromStored('user-claim'),
			orgSlug: 'ada',
			day: '2026-08-29',
		}),
	).toBe(true)
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

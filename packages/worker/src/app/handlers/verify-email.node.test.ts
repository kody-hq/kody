import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { executeVerifyEmail } from '#app/handlers/verify-email.ts'
import { verifyEmailToken } from '#app/email-verification.ts'
import { sendConnectAgentEmail } from '#app/user-account-emails.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { maybeRewardHeldReferralAfterEmailVerified } from '#worker/entitlements/referral-program.ts'

const waitUntilImpl = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		waitUntil: (promise: Promise<unknown>) => {
			waitUntilImpl(promise)
			void Promise.resolve(promise).catch(() => {})
		},
	}
})

vi.mock('#app/email-verification.ts', () => ({
	verifyEmailToken: vi.fn(),
}))

vi.mock('#app/user-account-emails.ts', () => ({
	sendConnectAgentEmail: vi.fn(async () => true),
}))

vi.mock('#worker/kit/subscriber-sync.ts', () => ({
	scheduleKitSubscriberSync: vi.fn(),
}))

vi.mock('#worker/entitlements/referral-program.ts', () => ({
	maybeRewardHeldReferralAfterEmailVerified: vi.fn(async () => ({
		outcome: 'ignored',
		reason: 'no_held',
	})),
}))

test('verify-email handler wires success CTA from redirectTo and rejects open redirects', async () => {
	waitUntilImpl.mockClear()
	vi.mocked(sendConnectAgentEmail).mockClear()
	vi.mocked(verifyEmailToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'verified@example.com',
		stableUserId: ownerIdFromStored('user_verified'),
		newlyVerified: false,
	})
	const env = {
		APP_DB: {} as D1Database,
	} as Env

	const oauthResume = '/oauth/authorize?client_id=demo'
	const oauthResponse = await executeVerifyEmail({
		request: new Request('https://example.com/_serverFn/verify'),
		env,
		token: 'ok',
		redirectTo: oauthResume,
	})
	expect(oauthResponse).toMatchObject({
		ok: true,
		kind: 'email_verify',
		message: expect.any(String),
		ctaHref: oauthResume,
		ctaLabel: 'Continue authorization',
	})

	const maliciousResponse = await executeVerifyEmail({
		request: new Request('https://example.com/_serverFn/verify'),
		env,
		token: 'ok',
		redirectTo: 'https://evil.example',
	})
	expect(maliciousResponse).toMatchObject({
		ok: true,
		kind: 'email_verify',
		message: expect.any(String),
		ctaHref: '/onboarding',
		ctaLabel: 'Continue to onboarding',
	})

	expect(sendConnectAgentEmail).not.toHaveBeenCalled()
	expect(waitUntilImpl).not.toHaveBeenCalled()
	expect(scheduleKitSubscriberSync).not.toHaveBeenCalled()
	expect(maybeRewardHeldReferralAfterEmailVerified).not.toHaveBeenCalled()
})

test('verify-email sends the connect-agent mail only on newly verified accounts', async () => {
	waitUntilImpl.mockClear()
	vi.mocked(sendConnectAgentEmail).mockClear()
	let releaseSend: (sent: boolean) => void = () => {}
	const sendGate = new Promise<boolean>((resolve) => {
		releaseSend = resolve
	})
	vi.mocked(sendConnectAgentEmail).mockReturnValueOnce(sendGate)
	vi.mocked(verifyEmailToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'verified@example.com',
		stableUserId: ownerIdFromStored('user_verified'),
		newlyVerified: true,
	})
	const env = {
		APP_DB: {} as D1Database,
	} as Env
	const handled = executeVerifyEmail({
		request: new Request('https://example.com/verify-email?token=ok'),
		env,
		token: 'ok',
	})
	const response = await Promise.race([
		handled,
		new Promise<Awaited<ReturnType<typeof executeVerifyEmail>>>((_, reject) => {
			setTimeout(
				() => reject(new Error('verify page waited on the connect-agent send')),
				1_000,
			)
		}),
	])
	expect(response.ok).toBe(true)
	expect(sendConnectAgentEmail).toHaveBeenCalledWith({
		env: expect.anything(),
		email: 'verified@example.com',
		userId: ownerIdFromStored('user_verified'),
		requestUrl: 'https://example.com/verify-email?token=ok',
	})
	const waited = waitUntilImpl.mock.calls.map(
		(call) => call[0] as Promise<unknown>,
	)
	expect(waited.length).toBeGreaterThan(0)
	const settled = await Promise.all(
		waited.map(async (promise) => {
			let done = false
			void promise.finally(() => {
				done = true
			})
			await Promise.resolve()
			return done
		}),
	)
	expect(settled).toContain(false)
	releaseSend(true)
	await Promise.all(waited)
	expect(scheduleKitSubscriberSync).toHaveBeenCalledWith({
		env: expect.anything(),
		email: 'verified@example.com',
		stableUserId: ownerIdFromStored('user_verified'),
	})
	expect(maybeRewardHeldReferralAfterEmailVerified).toHaveBeenCalledWith(
		expect.objectContaining({
			db: expect.anything(),
			stableUserId: ownerIdFromStored('user_verified'),
		}),
	)
})

import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ allowed: vi.fn(), send: vi.fn() }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => ({
		userId: 7,
		email: 'person@example.com',
		emailVerified: false,
		mcpUser: { userId: 'a'.repeat(64) },
	}),
}))
vi.mock('#app/email-verification.ts', () => ({
	createEmailVerification: state.send,
}))
vi.mock('#worker/account/deletion-state.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	assertAccountWritableDb: async () => {},
}))
vi.mock('#worker/email/verification-delivery.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	assertVerificationResendAllowed: state.allowed,
}))
import { EmailVerificationSendBlockedError } from '#worker/email/verification-delivery.ts'
import { resendWebsiteVerification } from './account-resend-verification-operations.ts'
test('native resend returns recipient cooldown detail without attempting a send', async () => {
	state.allowed.mockRejectedValue(
		new EmailVerificationSendBlockedError(
			'Wait until 18:00 before sending to this address again.',
		),
	)
	const request = new Request('https://kody.test/_serverFn/resend')
	const result = await resendWebsiteVerification({
		env: { APP_DB: {} } as Env,
		request,
		url: new URL('/account', request.url),
		body: {},
	})
	expect(result.status).toBe(409)
	expect(result.data).toEqual({
		ok: false,
		code: 'sender_block',
		error: 'Wait until 18:00 before sending to this address again.',
	})
	expect(state.send).not.toHaveBeenCalled()
})

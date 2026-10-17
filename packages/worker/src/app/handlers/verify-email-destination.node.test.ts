import { expect, test, vi } from 'vitest'
import { executeVerifyEmailDestination } from '#app/handlers/verify-email-destination.ts'
import { verifyEmailDestinationToken } from '#worker/email/destination-verification.ts'

vi.mock('#worker/email/destination-verification.ts', () => ({
	verifyEmailDestinationToken: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', () => ({
	auditDatabaseFromEnv: vi.fn(),
	getRequestIp: vi.fn(() => null),
	logAuditEvent: vi.fn(),
}))

test('verified destination CTA returns to the email inbox destinations panel', async () => {
	vi.mocked(verifyEmailDestinationToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'pager@example.com',
	})
	const env = {
		APP_DB: {} as D1Database,
	} as Env

	const response = await executeVerifyEmailDestination({
		request: new Request('https://example.com/verify-email-destination'),
		env,
		token: 'ok',
	})

	expect(response).toMatchObject({
		ok: true,
		kind: 'email_destination',
		ctaHref: '/account/email#email-destinations',
	})
})

test('destination verification failures offer a resend path', async () => {
	const env = { APP_DB: {} as D1Database } as Env
	vi.mocked(verifyEmailDestinationToken).mockResolvedValue({
		ok: false,
		reason: 'invalid_token',
	})
	const failed = await executeVerifyEmailDestination({
		request: new Request('https://example.com/verify-email-destination'),
		env,
		token: 'nope',
	})
	expect(failed).toMatchObject({
		ok: false,
		kind: 'email_destination',
		reason: 'invalid_token',
		ctaHref: '/account/email#email-destinations',
	})
})

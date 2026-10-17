import { expect, test, vi } from 'vitest'
import {
	verifyEmailDestinationHead,
	unsubscribeTipsPost,
} from './action-page-http.ts'

const { verifyToken, auditEvent, bindings } = vi.hoisted(() => ({
	verifyToken: vi.fn(),
	auditEvent: vi.fn(),
	bindings: { APP_DB: {} },
}))
vi.mock('cloudflare:workers', () => ({ env: bindings }))
vi.mock('../../src/app/env.ts', () => ({ getEnv: () => bindings }))
vi.mock('../../src/email/destination-verification.ts', () => ({
	verifyEmailDestinationToken: verifyToken,
}))
vi.mock('../../src/audit-log.ts', () => ({
	auditDatabaseFromEnv: vi.fn(),
	getRequestIp: vi.fn(() => null),
	logAuditEvent: auditEvent,
}))

test.each([
	[{ ok: true, userId: 1, email: 'pager@example.com' }, 200],
	[{ ok: false, reason: 'invalid_token' }, 400],
] as const)(
	'native destination HEAD checks without consuming or auditing (%s)',
	async (result, status) => {
		vi.clearAllMocks()
		verifyToken.mockResolvedValue(result)
		const response = await verifyEmailDestinationHead({
			request: new Request(
				'https://kody.test/verify-email-destination?token=example',
				{ method: 'HEAD' },
			),
		})
		expect(response.status).toBe(status)
		expect(await response.text()).toBe('')
		expect(verifyToken).toHaveBeenCalledExactlyOnceWith({
			db: bindings.APP_DB,
			token: 'example',
			consume: false,
		})
		expect(auditEvent).not.toHaveBeenCalled()
	},
)

const { unsubscribe } = vi.hoisted(() => ({ unsubscribe: vi.fn() }))
vi.mock('../../src/app/handlers/unsubscribe-tips.ts', () => ({
	executeUnsubscribeTips: unsubscribe,
}))

test.each(['List-Unsubscribe=One-Click', ''])(
	'RFC one-click POST invokes the token operation (%s)',
	async (body) => {
		vi.clearAllMocks()
		unsubscribe.mockResolvedValue({
			ok: true,
			title: 'Unsubscribed from tips',
			message: 'Unsubscribed.',
		})
		const request = new Request(
			'https://kody.test/unsubscribe/tips?token=signed-token',
			{ method: 'POST', body },
		)
		const response = await unsubscribeTipsPost({ request })
		expect(unsubscribe).toHaveBeenCalledExactlyOnceWith({
			request,
			env: bindings,
			token: 'signed-token',
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe(
			'text/plain; charset=utf-8',
		)
		expect(await response.text()).toBe('Unsubscribed.')
	},
)

test('invalid one-click body cannot consume a token or unsubscribe', async () => {
	vi.clearAllMocks()
	const response = await unsubscribeTipsPost({
		request: new Request(
			'https://kody.test/unsubscribe/tips?token=signed-token',
			{ method: 'POST', body: 'unexpected' },
		),
	})
	expect(response.status).toBe(400)
	expect(unsubscribe).not.toHaveBeenCalled()
	expect(auditEvent).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			category: 'auth',
			action: 'tips_unsubscribe',
			result: 'failure',
			path: '/unsubscribe/tips',
			reason: 'invalid_one_click_body',
		}),
	)
})

test('one-click POST preserves invalid-token denial as plain text', async () => {
	vi.clearAllMocks()
	unsubscribe.mockResolvedValue({
		ok: false,
		status: 400,
		error: 'Unsubscribe link is invalid.',
	})
	const response = await unsubscribeTipsPost({
		request: new Request('https://kody.test/unsubscribe/tips?token=invalid', {
			method: 'POST',
			body: 'List-Unsubscribe=One-Click',
		}),
	})
	expect(response.status).toBe(400)
	expect(await response.text()).toBe('Unsubscribe link is invalid.')
})

import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/decision?client_id=wrong', {
		method: 'POST',
		headers: { cookie: 'session=original' },
	}),
	env: { COOKIE_SECRET: 'test' },
	operation: vi.fn(),
	protection: vi.fn(),
	lease: vi.fn(),
	header: vi.fn(),
	status: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate: { parse: (value: unknown) => unknown }
		const builder = {
			inputValidator(schema: typeof validate) {
				validate = schema
				return builder
			},
			handler(fn: (args: { data: unknown }) => unknown) {
				return (args: { data: unknown }) =>
					fn({ data: validate.parse(args.data) })
			},
		}
		return builder
	},
}))
vi.mock('./auth-mutation-context.ts', () => ({
	publicAuthContext: async () => ({ request: state.request, env: state.env }),
}))
vi.mock('../../src/oauth-handlers.ts', () => ({
	decideOAuthAuthorization: state.operation,
}))
vi.mock('../../src/app/public-form-protection.ts', () => ({
	checkPublicFormProtection: state.protection,
}))
vi.mock('../../src/app/account-write-lease-middleware.ts', () => ({
	withAccountRequestWriteLease: state.lease,
}))
vi.mock('@tanstack/react-start/server', () => ({
	setResponseHeader: state.header,
	setResponseStatus: state.status,
}))
import { submitOAuthDecision } from './oauth-decision.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.protection.mockResolvedValue({ ok: true })
	state.lease.mockImplementation(async (_request, _env, next) => next())
	state.operation.mockResolvedValue({
		data: { ok: true, redirectTo: 'https://client.test/callback?code=ok' },
		status: 200,
		headers: new Headers({
			'Set-Cookie': 'session=updated; HttpOnly',
			'Retry-After': '30',
		}),
	})
})
test('website consent retains original request identity, explicit authorize query, write fencing and cookies', async () => {
	const result = await submitOAuthDecision({
		data: {
			search: '?client_id=trusted&org=team&profile=review',
			fields: {
				decision: 'approve',
				email: 'a@test.com',
				password: 'password',
			},
		},
	})
	expect(result).toMatchObject({
		successful: true,
		redirectTo: 'https://client.test/callback?code=ok',
	})
	expect(state.protection).toHaveBeenCalledWith(
		expect.objectContaining({ request: state.request, env: state.env }),
	)
	expect(state.lease).toHaveBeenCalledWith(
		state.request,
		state.env,
		expect.any(Function),
	)
	const input = state.operation.mock.calls[0]![0]
	expect(input.request).toBe(state.request)
	expect(input.authorizeUrl.href).toBe(
		'https://kody.test/oauth/authorize?client_id=trusted&org=team&profile=review',
	)
	expect(input.formData.get('decision')).toBe('approve')
	expect(state.header).toHaveBeenCalledWith('Retry-After', '30')
	expect(state.header).toHaveBeenCalledWith('Set-Cookie', [
		'session=updated; HttpOnly',
	])
})
test('rejected public form protection and deletion fence never issue authorization', async () => {
	state.protection.mockResolvedValueOnce({
		ok: false,
		error: 'Human verification failed.',
	})
	expect(
		await submitOAuthDecision({
			data: {
				search: '',
				fields: { decision: 'approve', email: 'a@test.com' },
			},
		}),
	).toMatchObject({ successful: false })
	expect(state.operation).not.toHaveBeenCalled()
	state.lease.mockResolvedValueOnce(
		Response.json({ error: { code: 'account_deleting' } }, { status: 409 }),
	)
	await expect(
		submitOAuthDecision({ data: { search: '', fields: { decision: 'deny' } } }),
	).rejects.toThrow('Account deletion')
	expect(state.status).toHaveBeenCalledWith(409)
	expect(state.operation).not.toHaveBeenCalled()
})

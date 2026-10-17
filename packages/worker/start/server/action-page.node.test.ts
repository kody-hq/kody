import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/token?token=wrong', {
		method: 'POST',
		headers: { cookie: 'session=original' },
	}),
	operation: vi.fn(),
	status: vi.fn(),
	header: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate: (input: unknown) => unknown
		const builder = {
			validator(fn: typeof validate) {
				validate = fn
				return builder
			},
			handler(fn: (args: { data: unknown }) => unknown) {
				return (args: { data: unknown }) => fn({ data: validate(args.data) })
			},
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('../../src/app/env.ts', () => ({
	getEnv: () => ({ binding: 'trusted' }),
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseStatus: state.status,
	setResponseHeader: state.header,
}))
vi.mock('../../src/app/handlers/verify-email.ts', () => ({
	executeVerifyEmail: state.operation,
}))
vi.mock('../../src/app/handlers/verify-email-change.ts', () => ({
	executeVerifyEmailChange: state.operation,
}))
vi.mock('../../src/app/handlers/verify-email-claim-release.ts', () => ({
	executeVerifyEmailClaimRelease: state.operation,
}))
vi.mock('../../src/app/handlers/verify-email-destination.ts', () => ({
	executeVerifyEmailDestination: state.operation,
}))
vi.mock('../../src/app/handlers/unsubscribe-tips.ts', () => ({
	executeUnsubscribeTips: state.operation,
}))
import {
	loadVerifyEmail,
	loadVerifyEmailChange,
	loadVerifyEmailClaimRelease,
	loadVerifyEmailDestination,
	loadUnsubscribeTips,
} from './action-page.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.operation.mockResolvedValue({
		title: 'Token result',
		status: 400,
		setCookie: 'session=updated; HttpOnly',
		ok: false,
		error: 'Invalid',
	})
})
test.each([
	loadVerifyEmail,
	loadVerifyEmailChange,
	loadVerifyEmailClaimRelease,
	loadVerifyEmailDestination,
	loadUnsubscribeTips,
])(
	'token function uses validated input and original request, forwards status/cookies',
	async (fn) => {
		if (fn === loadUnsubscribeTips)
			state.operation.mockResolvedValue({
				title: 'Token result',
				status: 400,
				ok: false,
				error: 'Invalid',
			})
		const data = {
			token: 'explicit-token',
			request: 'untrusted',
			env: 'untrusted',
		}
		const result = await fn({ data })
		expect(result).toEqual({
			title: 'Token result',
			ok: false,
			error: 'Invalid',
		})
		expect(state.operation).toHaveBeenCalledWith(
			expect.objectContaining({
				token: 'explicit-token',
				request: state.request,
				env: { binding: 'trusted' },
			}),
		)
		expect(state.status).toHaveBeenCalledWith(400)
		if (fn === loadUnsubscribeTips) expect(state.header).not.toHaveBeenCalled()
		else
			expect(state.header).toHaveBeenCalledWith(
				'Set-Cookie',
				'session=updated; HttpOnly',
			)
	},
)
test('RPC transport method does not select one-click unsubscribe or HEAD semantics', async () => {
	await loadUnsubscribeTips({ data: { token: 'tip' } })
	expect(state.operation).toHaveBeenLastCalledWith(
		expect.not.objectContaining({ oneClick: expect.anything() }),
	)
	await loadVerifyEmailDestination({ data: { token: 'destination' } })
	expect(state.operation).toHaveBeenLastCalledWith(
		expect.not.objectContaining({ consume: expect.anything() }),
	)
})
test('verification forwards only explicit redirect input', async () => {
	await loadVerifyEmail({
		data: { token: null, redirectTo: '/oauth/authorize?client_id=app' },
	})
	expect(state.operation).toHaveBeenCalledWith(
		expect.objectContaining({
			token: null,
			redirectTo: '/oauth/authorize?client_id=app',
		}),
	)
})

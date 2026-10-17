import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	method: 'POST',
	status: vi.fn(),
	header: vi.fn(),
	write: vi.fn(),
	complete: vi.fn(),
	pageAuth: vi.fn(),
}))
vi.mock('@tanstack/react-start', async (original) => ({
	...(await original<Record<string, unknown>>()),
	createServerFn: (options: { method: string }) => {
		let parse: (data: unknown) => unknown
		const builder = {
			validator(schema: { parse: (data: unknown) => unknown }) {
				parse = schema.parse.bind(schema)
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) => {
					expect(options.method).toBe('POST')
					return run({ data: parse(input.data) })
				}
			},
		}
		return builder
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: mocks.status,
	setResponseHeader: mocks.header,
	getRequest: () =>
		new Request('https://kody.test/@team/-/usage', { method: mocks.method }),
}))
vi.mock('./collection-context.ts', () => ({
	loadScopedCollection: mocks.pageAuth,
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: mocks.write,
}))
vi.mock('../../src/app/handlers/org-usage.ts', () => ({
	completeOrgCreditTopUp: mocks.complete,
}))
import { completeCreditTopUp } from './credit-top-up-completion.ts'
beforeEach(() => {
	vi.resetAllMocks()
	mocks.method = 'POST'
	mocks.write.mockImplementation(async (_scope, callback) =>
		callback({ env: 'env', user: 'authorized-user' }),
	)
	mocks.complete.mockResolvedValue({
		kind: 'redirect',
		href: '/@team/-/usage?credits=added#credits',
	})
})
test.each(['POST', 'GET'])(
	'completion uses authenticated scoped write lifecycle for %s transport',
	async (method) => {
		mocks.method = method
		await expect(
			completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
		).resolves.toEqual({ href: '/@team/-/usage?credits=added#credits' })
		expect(mocks.write).toHaveBeenCalledWith(
			{ scope: { orgSlug: 'team' } },
			expect.any(Function),
		)
		expect(mocks.complete).toHaveBeenCalledWith({
			env: 'env',
			user: 'authorized-user',
			orgSlug: 'team',
			sessionId: 'cs_1',
		})
	},
)
test('HEAD never authorizes or applies a credit top-up', async () => {
	mocks.method = 'HEAD'
	await expect(
		completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
	).rejects.toThrow('Method not allowed.')
	expect(mocks.status).toHaveBeenCalledWith(405)
	expect(mocks.header).toHaveBeenCalledWith('Allow', 'GET, POST')
	expect(mocks.write).not.toHaveBeenCalled()
	expect(mocks.complete).not.toHaveBeenCalled()
})
test('authorization and account lifecycle rejection prevent Stripe completion', async () => {
	mocks.write.mockRejectedValue(new Error('Account deletion is in progress.'))
	await expect(
		completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
	).rejects.toThrow('Account deletion is in progress.')
	expect(mocks.complete).not.toHaveBeenCalled()
})
test('domain permission rejection propagates instead of reporting added credits', async () => {
	mocks.complete.mockResolvedValue({
		kind: 'denied',
		status: 403,
		error: 'Billing access required',
	})
	await expect(
		completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
	).rejects.toThrow('Billing access required')
	expect(mocks.status).toHaveBeenCalledWith(403)
})

test('signed-out completion preserves the checkout return URL and never writes', async () => {
	const { redirect } = await import('@tanstack/react-router')
	const returnTo = '/@team/-/usage?topup=success&session_id=cs_1#credits'
	const login = redirect({
		href: `/login?redirectTo=${encodeURIComponent(returnTo)}`,
	})
	mocks.pageAuth.mockRejectedValueOnce(login)
	mocks.method = 'GET'
	await expect(
		completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
	).rejects.toBe(login)
	expect(mocks.pageAuth).toHaveBeenCalledWith({
		orgSlug: 'team',
		section: 'usage',
		returnTo,
	})
	expect(mocks.write).not.toHaveBeenCalled()
	expect(mocks.complete).not.toHaveBeenCalled()
})

test('missing organization uses native not-found instead of a raw HTTP response', async () => {
	mocks.complete.mockResolvedValue({
		kind: 'denied',
		status: 404,
		error: 'Organization unavailable.',
	})
	await expect(
		completeCreditTopUp({ data: { orgSlug: 'team', sessionId: 'cs_1' } }),
	).rejects.toMatchObject({ isNotFound: true })
})

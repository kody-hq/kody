import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/token?token=wrong', {
		method: 'GET',
		headers: { cookie: 'session=original' },
	}),
	operation: vi.fn(),
	resolvedAuth: vi.fn(),
	lease: vi.fn(),
	auth: vi.fn(),
	binding: vi.fn(),
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
	getEnv: () => ({ APP_DB: {}, COOKIE_SECRET: 'secret' }),
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: state.header,
	setResponseStatus: state.status,
}))
vi.mock('@tanstack/react-router', () => ({
	redirect: (value: unknown) => value,
	notFound: () => ({ isNotFound: true }),
}))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: state.auth,
}))
vi.mock('../../src/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: state.binding,
}))
vi.mock('../../src/request-context/request-context.ts', () => ({
	deriveRequestContext: ({ orgBinding }: { orgBinding: unknown }) => orgBinding,
}))
vi.mock('../../src/app/handlers/org-billing.ts', () => ({
	completeOrgBillingCheckout: state.operation,
}))
vi.mock('../../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: state.resolvedAuth,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: state.lease,
	AccountDeletionInProgressError: class AccountDeletionInProgressError extends Error {},
	AccountWriteLeaseLostError: class AccountWriteLeaseLostError extends Error {},
}))
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
} from '#worker/account/deletion-state.ts'
vi.mock('./document-head.ts', () => ({ loadDocumentHead: vi.fn() }))
import { loadBillingCompletion } from './billing-completion.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.request = new Request('https://kody.test/_serverFn/billing')
	state.resolvedAuth.mockResolvedValue({
		user: { accountDeleting: false, mcpUser: { userId: 'person' } },
	})
	state.lease.mockImplementation(
		async ({ write }: { write: () => Promise<unknown> }) => write(),
	)
	state.auth.mockResolvedValue({
		mcpUser: { userId: 'person' },
		request: { org: { id: 'personal' } },
	})
	state.binding.mockResolvedValue({ org: { id: 'team' } })
	state.operation.mockResolvedValue({ ok: true, needsOnboarding: false })
})
test('checkout binds explicit organization, preserves original request and explicit Stripe session', async () => {
	await loadBillingCompletion({
		data: { orgSlug: 'team', sessionId: 'cs_checkout' },
	})
	expect(state.auth).toHaveBeenCalledWith(state.request, expect.anything(), {
		redirectTo: '/@team/-/billing/success?session_id=cs_checkout',
	})
	expect(state.binding).toHaveBeenCalledWith(
		expect.anything(),
		'person',
		'team',
	)
	expect(state.operation).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			orgSlug: 'team',
			sessionId: 'cs_checkout',
			user: expect.objectContaining({ request: { org: { id: 'team' } } }),
		}),
	)
})
test('anonymous checkout preserves login redirect cookies and does not call Stripe', async () => {
	state.resolvedAuth.mockResolvedValue({ user: null })
	state.auth.mockResolvedValue(
		new Response(null, {
			status: 302,
			headers: {
				Location: '/login?redirectTo=checkout',
				'Set-Cookie': 'session=; Max-Age=0',
			},
		}),
	)
	await expect(
		loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		}),
	).rejects.toMatchObject({
		href: '/login?redirectTo=checkout',
		statusCode: 302,
	})
	expect(state.header).toHaveBeenCalledWith('Set-Cookie', [
		'session=; Max-Age=0',
	])
	expect(state.operation).not.toHaveBeenCalled()
})
test('unknown organization is denied before completion', async () => {
	state.binding.mockResolvedValue(null)
	await expect(
		loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		}),
	).rejects.toMatchObject({ isNotFound: true })
	expect(state.operation).not.toHaveBeenCalled()
})
test('HEAD cannot authenticate or complete checkout', async () => {
	state.request = new Request('https://kody.test/_serverFn/billing', {
		method: 'HEAD',
	})
	await expect(
		loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		}),
	).rejects.toThrow('Method not allowed.')
	expect(state.status).toHaveBeenCalledWith(405)
	expect(state.header).toHaveBeenCalledWith('Allow', 'GET')
	expect(state.auth).not.toHaveBeenCalled()
	expect(state.operation).not.toHaveBeenCalled()
})

test.each([
	'https://kody.test/_serverFn/billing',
	'https://kody.test/@team/-/billing/success?session_id=cs_checkout',
])(
	'both native RPC and document completion hold a single personal-account lease: %s',
	async (url) => {
		state.request = new Request(url)
		state.operation.mockImplementation(async () => {
			expect(state.lease).toHaveBeenCalledOnce()
			return { ok: true, needsOnboarding: false }
		})
		await loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		})
		expect(state.lease).toHaveBeenCalledWith(
			expect.objectContaining({
				stableUserId: 'person',
				write: expect.any(Function),
			}),
		)
		expect(state.operation).toHaveBeenCalledOnce()
	},
)
test('deleting accounts receive 409 before authentication, scope lookup or Stripe work', async () => {
	state.resolvedAuth.mockResolvedValue({
		user: { accountDeleting: true, mcpUser: { userId: 'person' } },
	})
	await expect(
		loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		}),
	).rejects.toThrow(
		'Account deletion is in progress; user-owned writes are disabled.',
	)
	expect(state.status).toHaveBeenCalledWith(409)
	expect(state.lease).not.toHaveBeenCalled()
	expect(state.auth).not.toHaveBeenCalled()
	expect(state.operation).not.toHaveBeenCalled()
})
test.each([
	[new AccountDeletionInProgressError(), 409],
	[new AccountWriteLeaseLostError(), 503],
])(
	'native lease errors preserve their HTTP status instead of becoming redirects',
	async (error, status) => {
		state.lease.mockRejectedValue(error)
		await expect(
			loadBillingCompletion({
				data: { orgSlug: 'team', sessionId: 'cs_checkout' },
			}),
		).rejects.toThrow(
			'Account deletion is in progress; user-owned writes are disabled.',
		)
		expect(state.status).toHaveBeenCalledWith(status)
		expect(state.operation).not.toHaveBeenCalled()
	},
)

test('checkout permission denial rejects with its message and HTTP status', async () => {
	state.operation.mockResolvedValue({
		ok: false,
		status: 403,
		error: 'Billing access required',
	})
	await expect(
		loadBillingCompletion({
			data: { orgSlug: 'team', sessionId: 'cs_checkout' },
		}),
	).rejects.toThrow('Billing access required')
	expect(state.status).toHaveBeenCalledWith(403)
})

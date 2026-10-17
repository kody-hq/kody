import { beforeEach, expect, it, vi } from 'vitest'
import {
	documentActorHeader,
	documentDestinationHeader,
} from '../session-identity.ts'

const mocks = vi.hoisted(() => ({
	request: new Request('https://kody.example/_serverFn/read'),
	headers: vi.fn(),
	auth: vi.fn(),
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => mocks.request,
	setResponseHeader: mocks.headers,
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('../../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: mocks.auth,
}))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/env.ts', () => ({
	getEnv: () => ({ COOKIE_SECRET: 'test-only-secret' }),
}))
import {
	markRpcResponsePrivate,
	verifyBrowserDocument,
} from './document-actor.ts'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.request = new Request('https://kody.example/_serverFn/read')
})
it('marks every RPC private and allows unbound requests through existing handler auth', async () => {
	markRpcResponsePrivate()
	await verifyBrowserDocument()
	expect(mocks.headers).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
	expect(mocks.auth).not.toHaveBeenCalled()
})
it('uses actual cookie auth, never the caller binding, to decide response ownership', async () => {
	mocks.request = new Request(mocks.request, {
		headers: {
			[documentActorHeader]: '"actor-a"',
			[documentDestinationHeader]: '/account',
		},
	})
	mocks.auth.mockResolvedValue({ user: { mcpUser: { userId: 'actor-b' } } })
	await expect(verifyBrowserDocument()).rejects.toMatchObject({
		options: { reloadDocument: true, href: '/account' },
	})
	expect(mocks.auth.mock.calls[0]?.[0]).toBe(mocks.request)
})
it('matches shell semantics for suspended and deleting accounts', async () => {
	mocks.request = new Request(mocks.request, {
		headers: {
			[documentActorHeader]: 'null',
			[documentDestinationHeader]: '/account',
		},
	})
	for (const flag of ['accountSuspended', 'accountDeleting']) {
		mocks.auth.mockResolvedValue({
			user: { mcpUser: { userId: 'actor-a' }, [flag]: true },
		})
		await expect(verifyBrowserDocument()).resolves.toBeUndefined()
	}
})

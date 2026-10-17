import type * as accountExperimentsData from '#app/account-experiments-data.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { loadExperimentsPage } from '../../../start/server/account-collections.ts'
import { testAccountExperimentsApiHandler } from './account-experiments.test-support.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	loadAccountExperimentsData: vi.fn(),
	setExperimentsOptIn: vi.fn<typeof accountExperimentsData.setExperimentsOptIn>(
		async () => undefined,
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/account-experiments-data.ts', () => ({
	loadAccountExperimentsData: (...args: Array<unknown>) =>
		mockModule.loadAccountExperimentsData(...args),
	setExperimentsOptIn: (
		...args: Parameters<typeof accountExperimentsData.setExperimentsOptIn>
	) => mockModule.setExperimentsOptIn(...args),
}))

vi.mock('@tanstack/react-start', async () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	env: { APP_DB: {}, COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.example/_serverFn/experiments'),
	setResponseHeader: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('#app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('#app/org-request-binding.ts', () => ({}))

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

function createUser() {
	return {
		sessionUserId: '7',
		userId: 7,
		username: 'jane',
		email: 'jane@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'jane',
		roles: ['user'] as const,
		permissions: [],
		artifactOwnerIds: ['7'],
		mcpUser: {
			userId: ownerIdFromStored('a').repeat(64),
			email: 'jane@example.com',
			username: 'jane',
			displayName: 'jane',
		},
	}
}

test('native experiments loader requires authentication and returns persisted opt-in state', async () => {
	const loginRedirect = new Response(null, {
		status: 302,
		headers: { Location: '/login' },
	})
	mockModule.requireAuthenticatedPageUser.mockResolvedValueOnce(loginRedirect)
	await expect(loadExperimentsPage({ data: {} })).rejects.toMatchObject({
		options: { href: '/login', statusCode: 302 },
	})
	mockModule.requireAuthenticatedPageUser.mockResolvedValueOnce(createUser())
	mockModule.loadAccountExperimentsData.mockResolvedValueOnce({
		ok: true,
		experimentsOptIn: false,
	})
	const result = await loadExperimentsPage({ data: {} })
	expect(result.payload).toEqual({ ok: true, experimentsOptIn: false })
	expect(mockModule.loadAccountExperimentsData).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 7,
	})
})

test('account experiments API persists opt-in and opt-out with audit', async () => {
	const env = createEnv()
	const handler = testAccountExperimentsApiHandler(env)
	const url = new URL('https://kody.example/account/experiments.json')

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.execute({
		request: new Request(url, { method: 'GET' }),
		params: {},
		url,
	} as never)
	expect(unauthorized.status).toBe(401)

	const user = createUser()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(user)
	mockModule.loadAccountExperimentsData.mockRejectedValue(
		new Error('Preference read unavailable'),
	)
	const optIn = await handler.execute({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: true }),
		}),
		params: {},
		url,
	} as never)
	expect(mockModule.loadAccountExperimentsData).not.toHaveBeenCalled()
	expect(mockModule.setExperimentsOptIn).toHaveBeenCalledWith(env.APP_DB, {
		userId: 7,
		enabled: true,
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'experiments_opt_in',
			result: 'success',
			email: 'jane@example.com',
			reason: 'experiments_opt_in=true',
		}),
	)
	expect(optIn.data).toEqual({
		ok: true,
		experimentsOptIn: true,
	})

	await handler.execute({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: false }),
		}),
		params: {},
		url,
	} as never)
	expect(mockModule.setExperimentsOptIn).toHaveBeenCalledWith(env.APP_DB, {
		userId: 7,
		enabled: false,
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'experiments_opt_out',
			reason: 'experiments_opt_in=false',
		}),
	)

	const badBody = await handler.execute({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ experimentsOptIn: 'yes' }),
		}),
		params: {},
		url,
	} as never)
	expect(badBody.status).toBe(400)
})

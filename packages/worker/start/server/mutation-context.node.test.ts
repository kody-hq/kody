import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	authenticated: vi.fn(),
	auth: vi.fn(),
	binding: vi.fn(),
	lease: vi.fn(),
	header: vi.fn(),
	env: { APP_DB: {}, OAUTH_PROVIDER: { revokeGrant: vi.fn() } },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () =>
		new Request('https://kody.test/_serverFn/test', {
			method: 'POST',
			headers: { Referer: 'https://kody.test/@wrong/-/settings' },
		}),
	setResponseHeader: state.header,
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => ({ env: state.env }),
}))
vi.mock('#app/env.ts', () => ({ getEnv: (value: unknown) => value }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: state.authenticated,
}))
vi.mock('#app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: state.auth,
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: state.binding,
}))
vi.mock('#worker/request-context/request-context.ts', () => ({
	deriveRequestContext: (value: unknown) => value,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: state.lease,
}))
import {
	withWebsiteRead,
	withWebsiteMutation,
	WebsiteAuthenticationError,
} from './mutation-context.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.authenticated.mockResolvedValue({
		mcpUser: { userId: 'person_test' },
		request: { original: true },
	})
	state.auth.mockResolvedValue({ user: { accountDeleting: false } })
	state.binding.mockResolvedValue({ org: { slug: 'team' }, role: 'member' })
	state.lease.mockImplementation(
		({ write }: { write: () => Promise<unknown> }) => write(),
	)
})
test('unauthenticated or suspended sessions fail before reading or writing', async () => {
	state.authenticated.mockResolvedValue(null)
	const operation = vi.fn()
	await expect(withWebsiteRead({}, operation)).rejects.toBeInstanceOf(
		WebsiteAuthenticationError,
	)
	await expect(withWebsiteMutation({}, operation)).rejects.toThrow('sign in')
	expect(operation).not.toHaveBeenCalled()
	expect(state.lease).not.toHaveBeenCalled()
})
test('deletion gate refuses writes before acquiring a lease', async () => {
	state.auth.mockResolvedValue({ user: { accountDeleting: true } })
	await expect(withWebsiteMutation({}, vi.fn())).rejects.toThrow('deletion')
	expect(state.lease).not.toHaveBeenCalled()
})
test('unknown org and grant-only org membership fail closed', async () => {
	state.binding.mockResolvedValue(null)
	await expect(
		withWebsiteRead({ scope: { orgSlug: 'team' } }, vi.fn()),
	).rejects.toThrow('Organization')
	state.binding.mockResolvedValue({ org: { slug: 'team' }, role: null })
	await expect(
		withWebsiteMutation({ scope: { orgSlug: 'team' } }, vi.fn()),
	).rejects.toThrow('Organization')
})
test('resource-grant reads explicitly allow no membership without modifying cached session scope', async () => {
	const original = {
		mcpUser: { userId: 'person_test' },
		request: { original: true },
	}
	state.authenticated.mockResolvedValue(original)
	state.binding.mockResolvedValue({ org: { slug: 'team' }, role: null })
	await withWebsiteRead(
		{ scope: { orgSlug: 'team', requireMembership: false } },
		async ({ user }) => {
			expect(user.request).not.toEqual(original.request)
		},
	)
	expect(original.request).toEqual({ original: true })
	expect(state.binding).toHaveBeenCalledWith(
		expect.anything(),
		'person_test',
		'team',
	)
	expect(state.header).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})

test('invalid explicit org slugs never reach storage or the operation', async () => {
	const operation = vi.fn()
	await expect(
		withWebsiteMutation({ scope: { orgSlug: '../other' } }, operation),
	).rejects.toThrow('Organization')
	expect(state.binding).not.toHaveBeenCalled()
	expect(state.lease).not.toHaveBeenCalled()
	expect(operation).not.toHaveBeenCalled()
})

test('resource-grant writes keep explicit scope and acquire the actor deletion lease', async () => {
	state.binding.mockResolvedValue({ org: { slug: 'granted' }, role: null })
	const result = await withWebsiteMutation(
		{ scope: { orgSlug: 'granted', requireMembership: false } },
		async ({ request, user }) => {
			expect(request.url).toBe('https://kody.test/_serverFn/test')
			expect(user.request).toMatchObject({
				orgBinding: { org: { slug: 'granted' }, role: null },
			})
			return { ok: true }
		},
	)
	expect(result).toEqual({ ok: true })
	expect(state.binding).toHaveBeenCalledWith(
		expect.anything(),
		'person_test',
		'granted',
	)
	expect(state.lease).toHaveBeenCalledWith(
		expect.objectContaining({
			stableUserId: 'person_test',
			holder: 'website:server-function',
			write: expect.any(Function),
		}),
	)
})

test('domain authorization failures propagate without successful mutation data', async () => {
	const denied = new Error('Not authorized for this resource')
	await expect(
		withWebsiteMutation({}, async () => {
			throw denied
		}),
	).rejects.toBe(denied)
	expect(state.lease).toHaveBeenCalledOnce()
})

test('write leases use the stamped personal org instead of the person id', async () => {
	state.authenticated.mockResolvedValue({
		mcpUser: { userId: 'person_test', personalOrgId: 'org_distinct' },
		request: { original: true },
	})
	await withWebsiteMutation({}, async () => ({ ok: true }))
	expect(state.lease).toHaveBeenCalledWith(
		expect.objectContaining({ stableUserId: 'org_distinct' }),
	)
})

test('request OAuth helpers reach reads, authenticated writes, and deletion leases', async () => {
	await withWebsiteRead({}, async ({ env }) => {
		expect(env).toBe(state.env)
	})
	await withWebsiteMutation({}, async ({ env }) => {
		expect(env).toBe(state.env)
	})
	expect(state.authenticated).toHaveBeenCalledWith(
		expect.any(Request),
		state.env,
	)
	expect(state.lease).toHaveBeenCalledWith(
		expect.objectContaining({ env: state.env }),
	)
})

test('native reads and writes clear invalidated session cookies before rejecting a tombstoned or orphaned person', async () => {
	state.authenticated.mockResolvedValue(null)
	const setCookie = 'kody_session=; Max-Age=0; Path=/; HttpOnly'
	state.auth.mockResolvedValue({ user: null, setCookie })
	const operation = vi.fn()
	await expect(withWebsiteRead({}, operation)).rejects.toBeInstanceOf(
		WebsiteAuthenticationError,
	)
	await expect(withWebsiteMutation({}, operation)).rejects.toBeInstanceOf(
		WebsiteAuthenticationError,
	)
	expect(state.header).toHaveBeenCalledWith('Set-Cookie', setCookie)
	expect(state.header).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
	expect(operation).not.toHaveBeenCalled()
	expect(state.lease).not.toHaveBeenCalled()
})

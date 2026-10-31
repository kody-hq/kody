import { expect, test, vi } from 'vitest'
import { type ResolvedRequestAuth } from '#app/request-auth-cache.ts'
import {
	handleMeHandleRedirect,
	isMeHandlePath,
	resolveMeHandleHref,
} from '#app/me-handle-redirect.ts'

const mocks = vi.hoisted(() => ({
	loadResolvedRequestAuth: vi.fn<() => Promise<ResolvedRequestAuth>>(),
}))

vi.mock('#app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: mocks.loadResolvedRequestAuth,
}))

vi.mock('#app/env.ts', () => ({ getEnv: (env: Env) => env }))

const env = {
	COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
} as unknown as Env

function signedInAs(
	username: string,
	overrides: Partial<NonNullable<ResolvedRequestAuth['user']>> = {},
	setCookie?: string,
) {
	mocks.loadResolvedRequestAuth.mockResolvedValue({
		sessionUserId: 'person-1',
		setCookie,
		user: {
			username,
			accountDeleting: false,
			accountSuspended: false,
			...overrides,
		} as NonNullable<ResolvedRequestAuth['user']>,
	})
}

function signedOut(setCookie?: string) {
	mocks.loadResolvedRequestAuth.mockResolvedValue({
		sessionUserId: null,
		setCookie,
		user: null,
	})
}

function redirectFor(path: string, init?: RequestInit) {
	return handleMeHandleRedirect(
		new Request(`https://kody.test${path}`, init),
		env,
	)
}

function expectPrivate(response: Response) {
	expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
	expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')
	expect(response.headers.get('Vary')).toBe('Cookie')
}

test('isMeHandlePath matches /@me and its subpaths in any case only', () => {
	for (const path of ['/@me', '/@me/', '/@ME/-/profiles', '/%40me/-/jobs']) {
		expect(isMeHandlePath(path)).toBe(true)
	}
	for (const path of ['/@meow', '/@me-too/-/jobs', '/me', '/@kent/@me', '/']) {
		expect(isMeHandlePath(path)).toBe(false)
	}
})

test('resolveMeHandleHref keeps the rest of the path and the query', () => {
	expect(
		resolveMeHandleHref(
			new URL('https://kody.test/@Me/-/profiles/abc?tab=grants&x=1#top'),
			'Kent',
		),
	).toBe('/@kent/-/profiles/abc?tab=grants&x=1')
	expect(resolveMeHandleHref(new URL('https://kody.test/@me'), 'kent')).toBe(
		'/@kent',
	)
})

test('signed-in /@me paths 302 to the person own handle without caching', async () => {
	signedInAs('kent', {}, 'refreshed=1')
	const cases = [
		['/@me', '/@kent'],
		['/@me/', '/@kent/'],
		['/@me/-/profiles', '/@kent/-/profiles'],
		['/@ME/-/settings?section=email', '/@kent/-/settings?section=email'],
		['/@me/kody-pkg', '/@kent/kody-pkg'],
	] as const
	for (const [from, to] of cases) {
		const response = await redirectFor(from)
		if (!response) throw new Error(`Expected a redirect for ${from}`)
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(to)
		expect(response.headers.get('Set-Cookie')).toBe('refreshed=1')
		expectPrivate(response)
	}
})

test('signed-out /@me visitors sign in and come back to /@me', async () => {
	signedOut('kody_session=; Max-Age=0')
	const response = await redirectFor('/@me/-/profiles?tab=grants')
	if (!response) throw new Error('Expected a login redirect')
	expect(response.status).toBe(302)
	const location = new URL(
		response.headers.get('Location') ?? '',
		'https://kody.test',
	)
	expect(location.pathname).toBe('/login')
	expect(location.searchParams.get('redirectTo')).toBe(
		'/@me/-/profiles?tab=grants',
	)
	expect(response.headers.get('Set-Cookie')).toBe('kody_session=; Max-Age=0')
	expectPrivate(response)

	// After sign-in the login flow returns to /@me/..., which now resolves.
	signedInAs('ada')
	const resolved = await redirectFor(
		location.searchParams.get('redirectTo') ?? '',
	)
	expect(resolved?.headers.get('Location')).toBe('/@ada/-/profiles?tab=grants')
})

test('suspended or deleting accounts are treated as signed out', async () => {
	for (const flags of [{ accountSuspended: true }, { accountDeleting: true }]) {
		signedInAs('kent', flags)
		const response = await redirectFor('/@me/-/jobs')
		expect(response?.headers.get('Location')).toBe(
			'/login?redirectTo=%2F%40me%2F-%2Fjobs',
		)
	}
})

test('non-/@me paths fall through and writes are refused', async () => {
	mocks.loadResolvedRequestAuth.mockClear()
	expect(await redirectFor('/@kent/-/profiles')).toBeNull()
	expect(await redirectFor('/@meow')).toBeNull()
	expect(mocks.loadResolvedRequestAuth).not.toHaveBeenCalled()

	const post = await redirectFor('/@me/-/profiles', { method: 'POST' })
	expect(post?.status).toBe(405)
	if (post) expectPrivate(post)
})

import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { AppConsentRequiredError } from '#worker/app-visit/consent-required.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AppBaseUrl from '#worker/app-base-url.ts'

const mockModule = vi.hoisted(() => ({
	authorizeAppVisit: vi.fn(),
	getSavedPackageByIdInAnyOrg: vi.fn(),
	getOrgById: vi.fn(),
	servePackageAppRequest: vi.fn(),
	getPackageAppBaseUrl: vi.fn<typeof AppBaseUrl.getPackageAppBaseUrl>(
		() => 'https://apps.example.com',
	),
}))

vi.mock('#worker/app-visit/authorize.ts', () => ({
	authorizeAppVisit: (...args: Array<unknown>) =>
		mockModule.authorizeAppVisit(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByIdInAnyOrg(...args),
}))

vi.mock('#worker/orgs/repo.ts', async (original) => ({
	...(await original<object>()),
	getOrgById: (...args: Array<unknown>) => mockModule.getOrgById(...args),
}))

vi.mock('#worker/app-base-url.ts', async (original) => ({
	...(await original<object>()),
	getPackageAppBaseUrl: (
		...args: Parameters<typeof AppBaseUrl.getPackageAppBaseUrl>
	) => mockModule.getPackageAppBaseUrl(...args),
}))

vi.mock('#worker/package-runtime/package-app-serve.ts', async (original) => ({
	...(await original<object>()),
	servePackageAppRequest: (...args: Array<unknown>) =>
		mockModule.servePackageAppRequest(...args),
}))

const { appFetchCapability } = await import('./app-fetch.ts')

type ContextInput = {
	source?: 'mcp-oauth' | 'api-token'
	packageId?: string
	executionOrigin?: 'interactive' | 'background'
	profileId?: string
}

function fetchApp(args: Record<string, unknown>, input: ContextInput = {}) {
	return appFetchCapability.handler(args as never, {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source:
				input.source === 'api-token'
					? { kind: 'api-token', tokenId: 'token-1' }
					: { kind: input.source ?? 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: input.executionOrigin ?? 'interactive',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			storageContext: input.packageId
				? {
						sessionId: null,
						appId: null,
						packageId: input.packageId,
						storageId: null,
					}
				: null,
			...(input.profileId
				? { profileId: input.profileId, profileChain: [input.profileId] }
				: {}),
		}),
	})
}

function savedPackage() {
	return {
		id: 'package-1',
		userId: 'org-acme',
		name: '@acme/demo-app',
		kodyId: 'demo-app',
		hasApp: true,
		isInternetVisible: false,
	}
}

function allowVisit(overrides: Record<string, unknown> = {}) {
	mockModule.authorizeAppVisit.mockResolvedValue({
		kind: 'ok',
		owner: { userId: 'org-acme', username: 'acme', displayName: 'Acme' },
		app: savedPackage(),
		retiredSlug: false,
		visitor: { userId: 'user-1', username: 'kody', role: null },
		billedOrgId: 'user-1',
		needsRunConsent: false,
		epoch: 1,
		...overrides,
	})
}

const lastServe = () => mockModule.servePackageAppRequest.mock.calls.at(-1)?.[0]
const lastServedRequest = () => lastServe()?.request as Request

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.servePackageAppRequest.mockImplementation(
		async () => new Response(JSON.stringify({ ok: true })),
	)
})

test('appFetch makes a real visit to an app in another org through the one visit check', async () => {
	allowVisit()
	const result = await fetchApp({
		app: '@acme/demo-app',
		path: '/api/health?x=1',
		headers: { 'Kody-Synthetic': 'true', Authorization: 'Bearer nope' },
	})

	expect(result).toMatchObject({ status: 200, body: '{"ok":true}' })
	// The caller's own request goes to the visit check, named by owning org.
	const visit = mockModule.authorizeAppVisit.mock.calls[0]?.[0]
	expect(visit).toMatchObject({ ownerHandle: 'acme', appSlug: 'demo-app' })
	expect(visit.callerRequest.actor.userId).toBe('user-1')
	const served = lastServe()
	expect(served.dispatch).toEqual({ agent: true, synthetic: false })
	expect(served.visitor).toMatchObject({ userId: 'user-1', role: null })
	expect(served.owner).toMatchObject({ userId: 'org-acme', email: '' })
	expect(lastServedRequest().url).toBe(
		'https://demo-app--acme.apps.example.com/api/health?x=1',
	)
	// A caller cannot mark the visit synthetic, or pass credentials, by header.
	expect(lastServedRequest().headers.get('Kody-Synthetic')).toBeNull()
	expect(lastServedRequest().headers.get('Authorization')).toBeNull()
})

test('appFetch marks a smoke test only when synthetic is true', async () => {
	allowVisit()
	await fetchApp({ app: '@acme/demo-app', synthetic: true })
	expect(lastServe().dispatch).toEqual({ agent: true, synthetic: true })
})

test('appFetch passes the acting profile to the app with the person user id', async () => {
	allowVisit({
		visitor: {
			userId: 'user-1',
			username: 'kody',
			role: 'member',
			profile: { id: 'prf_1', name: 'researcher' },
			credential: { scopes: null, profileId: 'prf_1' },
		},
	})
	await fetchApp(
		{ app: '@acme/demo-app' },
		{ source: 'api-token', profileId: 'prf_1' },
	)
	expect(lastServe().visitor).toMatchObject({
		userId: 'user-1',
		profile: { id: 'prf_1', name: 'researcher' },
		credential: { profileId: 'prf_1' },
	})
})

test('appFetch resolves package_id and hosted URLs to the owning org', async () => {
	allowVisit()
	mockModule.getSavedPackageByIdInAnyOrg.mockResolvedValue(savedPackage())
	mockModule.getOrgById.mockResolvedValue({ id: 'org-acme', slug: 'acme' })
	await fetchApp({ package_id: 'package-1' })
	expect(mockModule.authorizeAppVisit.mock.calls.at(-1)?.[0]).toMatchObject({
		ownerHandle: 'acme',
		appSlug: 'demo-app',
	})

	await fetchApp({ app: 'https://heykody.dev/@acme/demo-app' })
	expect(mockModule.authorizeAppVisit.mock.calls.at(-1)?.[0]).toMatchObject({
		ownerHandle: 'acme',
		appSlug: 'demo-app',
	})
})

test('appFetch reads a refused or missing app as not found, and names a blocking profile', async () => {
	mockModule.authorizeAppVisit.mockResolvedValue({ kind: 'not-found' })
	await expect(fetchApp({ app: '@acme/demo-app' })).rejects.toThrow(
		/No app at "@acme\/demo-app" that you can run\. Check the address with appList/,
	)
	mockModule.authorizeAppVisit.mockResolvedValue({
		kind: 'forbidden',
		owner: {},
		app: savedPackage(),
		error: null,
	})
	await expect(fetchApp({ app: '@acme/demo-app' })).rejects.toThrow(/No app at/)
	const profileError = Object.assign(
		new Error('Profile "researcher" was not given app:execute.'),
		{
			code: 'profile_grant',
		},
	)
	mockModule.authorizeAppVisit.mockResolvedValue({
		kind: 'forbidden',
		owner: {},
		app: savedPackage(),
		error: profileError,
	})
	await expect(fetchApp({ app: '@acme/demo-app' })).rejects.toBe(profileError)
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()
})

test('appFetch returns the link the person opens when Run as me is not confirmed', async () => {
	allowVisit({ needsRunConsent: true })
	const error = await fetchApp({ app: '@acme/demo-app' }).catch((e) => e)
	expect(error).toBeInstanceOf(AppConsentRequiredError)
	expect(error).toMatchObject({
		code: 'app_consent_required',
		consent: 'run_as_me',
	})
	expect(error.consentUrl).toContain('https://heykody.dev/')
	expect(error.message).toContain(error.consentUrl)
	// Nothing ran, so nothing could record consent for the person.
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()
})

test('appFetch returns the link the person opens when a visitor need is not allowed', async () => {
	allowVisit()
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(
			JSON.stringify({
				need: 'github',
				consent_url:
					'https://demo-app--acme.apps.example.com/-/auth/login?app=demo-app&scope=profile+need%3Agithub',
			}),
			{ status: 403, headers: { 'X-Kody-Visitor-Consent': 'required' } },
		),
	)
	const error = await fetchApp({ app: '@acme/demo-app' }).catch((e) => e)
	expect(error).toBeInstanceOf(AppConsentRequiredError)
	expect(error).toMatchObject({
		consent: 'visitor_need',
		need: 'github',
		consentUrl:
			'https://demo-app--acme.apps.example.com/-/auth/login?app=demo-app&scope=profile+need%3Agithub',
	})
})

test('appFetch refuses a consent link an app forged for another site', async () => {
	allowVisit()
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(
			JSON.stringify({
				need: 'github',
				consent_url: 'https://evil.example/-/auth/login?app=demo-app',
			}),
			{ status: 403, headers: { 'X-Kody-Visitor-Consent': 'required' } },
		),
	)
	const error = await fetchApp({ app: '@acme/demo-app' }).catch((e) => e)
	expect(error).not.toBeInstanceOf(AppConsentRequiredError)
	expect(String(error.message)).not.toContain('evil.example')
})

test('appFetch refuses package app and job runtime callers', async () => {
	allowVisit()
	await expect(
		fetchApp({ app: '@acme/demo-app' }, { packageId: 'package-9' }),
	).rejects.toThrow(/Package app and job code cannot call it/)
	await expect(
		fetchApp({ app: '@acme/demo-app' }, { executionOrigin: 'background' }),
	).rejects.toThrow(/Package app and job code cannot call it/)
	expect(mockModule.authorizeAppVisit).not.toHaveBeenCalled()
})

test('appFetch rejects bad input before any access check', async () => {
	allowVisit()
	await expect(
		fetchApp({ app: '@acme/demo-app', path: '/a/../b' }),
	).rejects.toThrow(/parent traversal/)
	await expect(
		fetchApp({ app: '@acme/demo-app', method: 'TRACE' }),
	).rejects.toThrow(/does not support HTTP method/)
	await expect(
		fetchApp({ app: '@acme/demo-app', headers: { Upgrade: 'websocket' } }),
	).rejects.toThrow(/websocket/)
	await expect(fetchApp({ app: 'not an address' })).rejects.toThrow(
		/Pass the app as @org\/app or its hosted URL/,
	)
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()
})

test('appFetch keeps an MCP response at 100 KB whatever max_bytes asks for', async () => {
	allowVisit()
	mockModule.servePackageAppRequest.mockImplementation(
		async () =>
			new Response('a'.repeat(300_000), {
				headers: { 'Content-Type': 'text/plain' },
			}),
	)
	const result = await fetchApp({ app: '@acme/demo-app', max_bytes: 250_000 })
	expect(result.truncated).toBe(true)
	expect(result.body).toHaveLength(102_400)
})

test('appFetch returns a larger body to the Open API, up to the hard cap', async () => {
	allowVisit()
	mockModule.servePackageAppRequest.mockImplementation(
		async () =>
			new Response('a'.repeat(300_000), {
				headers: { 'Content-Type': 'text/plain' },
			}),
	)
	const byDefault = await fetchApp(
		{ app: '@acme/demo-app' },
		{ source: 'api-token' },
	)
	expect(byDefault.body).toHaveLength(102_400)
	const raised = await fetchApp(
		{ app: '@acme/demo-app', max_bytes: 250_000 },
		{ source: 'api-token' },
	)
	expect(raised).toMatchObject({ truncated: true })
	expect(raised.body).toHaveLength(250_000)

	// More than the hard cap is refused, and the hard cap itself truncates.
	mockModule.servePackageAppRequest.mockImplementation(
		async () => new Response('a'.repeat(10 * 1024 * 1024 + 4096)),
	)
	await expect(
		fetchApp(
			{ app: '@acme/demo-app', max_bytes: 10 * 1024 * 1024 + 1 },
			{ source: 'api-token' },
		),
	).rejects.toThrow()
	const capped = await fetchApp(
		{ app: '@acme/demo-app', max_bytes: 10 * 1024 * 1024 },
		{ source: 'api-token' },
	)
	expect(capped.truncated).toBe(true)
	expect(capped.body).toHaveLength(10 * 1024 * 1024)
})

test('appFetch counts a raised cap in file bytes and keeps a UTF-8 marker', async () => {
	allowVisit()
	mockModule.servePackageAppRequest.mockImplementation(
		async () =>
			new Response(new Uint8Array(200_000).fill(0xff), {
				headers: { 'Content-Type': 'application/zip' },
			}),
	)
	const binary = await fetchApp(
		{ app: '@acme/demo-app', max_bytes: 250_000 },
		{ source: 'api-token' },
	)
	expect(binary).toMatchObject({ body_encoding: 'base64', truncated: false })
	expect(Buffer.from(binary.body, 'base64')).toHaveLength(200_000)

	mockModule.servePackageAppRequest.mockImplementation(
		async () =>
			new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]), {
				headers: { 'Content-Type': 'text/csv' },
			}),
	)
	const csv = await fetchApp({ app: '@acme/demo-app' })
	expect(csv.body).toBe('\uFEFFa,b')
})

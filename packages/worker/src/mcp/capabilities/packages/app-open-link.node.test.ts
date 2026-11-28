import { DatabaseSync } from 'node:sqlite'
import { ensureOpenLinkTestSchema } from '#worker/app-visit/open-link-test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	consumePackageAppOpenLinkToken,
	packageAppOpenLinkQueryParam,
} from '#worker/app-visit/open-link.ts'
import { AppConsentRequiredError } from '#worker/app-visit/consent-required.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AppBaseUrl from '#worker/app-base-url.ts'
import type * as AppAddressModule from '#worker/app-visit/address.ts'
import type { AppAddress } from '#worker/app-visit/address.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	authorizeAppVisit: vi.fn(),
	getSavedPackageByIdInAnyOrg: vi.fn(),
	getOrgById: vi.fn(),
	servePackageAppRequest: vi.fn(),
	/** What address resolution returns for a verified custom domain. */
	customDomainAddress: vi.fn<(address: string) => AppAddress | null>(
		() => null,
	),
	getPackageAppBaseUrl: vi.fn<typeof AppBaseUrl.getPackageAppBaseUrl>(
		() => 'https://apps.example.com',
	),
}))

vi.mock('#worker/app-visit/authorize.ts', () => ({
	authorizeAppVisit: (...args: Array<unknown>) =>
		mockModule.authorizeAppVisit(...args),
}))

vi.mock('#worker/app-visit/address.ts', async (original) => {
	const actual = await original<typeof AppAddressModule>()
	return {
		...actual,
		resolveAppAddress: async (
			input: Parameters<typeof actual.resolveAppAddress>[0],
		) =>
			(await mockModule.customDomainAddress(input.address)) ??
			(await actual.resolveAppAddress(input)),
	}
})

vi.mock('#worker/package-app-profile-host.ts', () => ({
	hasProfilePackageApp: async () => false,
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

const { appOpenLinkCapability } = await import('./app-open-link.ts')

const personId = '1'.repeat(64)

const db = createD1FromSqlite(new DatabaseSync(':memory:'))
await ensureOpenLinkTestSchema(db)
const env = {
	APP_DB: db,
	COOKIE_SECRET: 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
	PACKAGE_APP_BASE_URL: 'https://apps.example.com',
} as unknown as Env

type ContextInput = {
	source?: 'mcp-oauth' | 'api-token'
	packageId?: string
	profileId?: string
	scopes?: Array<'app:execute' | 'app:read'>
}

function openLink(args: Record<string, unknown>, input: ContextInput = {}) {
	return appOpenLinkCapability.handler(args as never, {
		env,
		callerContext: createMcpCallerContext({
			source:
				input.source === 'api-token'
					? { kind: 'api-token', tokenId: 'token-1' }
					: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: 'interactive',
			user: {
				userId: personIdFromStored(personId),
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
				? {
						profileId: input.profileId,
						profileChain: ['prf_root', input.profileId],
					}
				: {}),
			...(input.scopes ? { scopes: input.scopes } : {}),
		}),
	})
}

function allowVisit(overrides: Record<string, unknown> = {}) {
	mockModule.authorizeAppVisit.mockResolvedValue({
		kind: 'ok',
		owner: { userId: 'org-acme', username: 'acme', displayName: 'Acme' },
		app: {
			id: 'package-1',
			userId: 'org-acme',
			name: '@acme/demo-app',
			kodyId: 'demo-app',
			hasApp: true,
			isInternetVisible: false,
		},
		retiredSlug: false,
		visitor: { userId: personId, username: 'kody', role: null },
		billedOrgId: personId,
		needsRunConsent: false,
		epoch: 1,
		...overrides,
	})
}

/** What opening the link on its own host would exchange it for. */
async function exchange(url: string) {
	const link = new URL(url)
	return await consumePackageAppOpenLinkToken({
		env,
		token: link.searchParams.get(packageAppOpenLinkQueryParam) ?? '',
		expected: { username: 'acme', kodyId: 'demo-app', host: link.host },
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.customDomainAddress.mockImplementation(() => null)
	mockModule.servePackageAppRequest.mockImplementation(
		async () => new Response(null, { status: 204 }),
	)
})

test('appOpenLink mints a link on the app host through the one visit check, without running the app', async () => {
	allowVisit()
	const before = Date.now()
	const result = await openLink({ app: '@acme/demo-app', path: '/cards?tab=2' })

	const link = new URL(result.url)
	expect(link.origin).toBe('https://demo-app--acme.apps.example.com')
	expect(link.pathname).toBe('/cards')
	expect(link.searchParams.get('tab')).toBe('2')
	expect(result).toMatchObject({
		app: '@acme/demo-app',
		expires_in_seconds: 300,
		session_seconds: 3600,
	})
	expect(Date.parse(result.expires_at)).toBeGreaterThanOrEqual(before + 300_000)
	expect(Date.parse(result.expires_at)).toBeLessThanOrEqual(
		Date.now() + 300_000,
	)

	// The caller's own request goes to the visit check, named by owning org.
	const visit = mockModule.authorizeAppVisit.mock.calls[0]?.[0]
	expect(visit).toMatchObject({ ownerHandle: 'acme', appSlug: 'demo-app' })
	expect(visit.callerRequest.actor.userId).toBe(personId)
	// Only the consent preflight ran: no app code, and no token in it.
	expect(mockModule.servePackageAppRequest).toHaveBeenCalledTimes(1)
	const preflight = mockModule.servePackageAppRequest.mock.calls[0]?.[0]
	expect(preflight.dispatch).toEqual({ agent: true, preflight: true })
	expect((preflight.request as Request).url).toBe(
		'https://demo-app--acme.apps.example.com/cards?tab=2',
	)

	// An unnarrowed sign-in mints a link for the person, with no narrowing.
	await expect(exchange(result.url)).resolves.toEqual({
		stableUserId: personId,
		username: 'acme',
		kodyId: 'demo-app',
		host: 'demo-app--acme.apps.example.com',
		credential: { kind: 'mcp-oauth', id: null, scopes: null },
	})
})

test('appOpenLink carries the calling profile chain and token scopes into the link', async () => {
	allowVisit({
		visitor: {
			userId: personId,
			username: 'kody',
			role: null,
			profile: { id: 'prf_research', name: 'Research bot' },
		},
	})
	const result = await openLink(
		{ app: '@acme/demo-app' },
		{
			source: 'api-token',
			profileId: 'prf_research',
			scopes: ['app:execute', 'app:read'],
		},
	)
	const claims = await exchange(result.url)
	expect(claims?.credential).toEqual({
		kind: 'api-token',
		id: 'token-1',
		scopes: ['app:execute', 'app:read'],
		profileId: 'prf_research',
		profileChain: ['prf_root', 'prf_research'],
		// The profile's home org: the caller's, not the app's.
		profileOrgId: ownerIdFromStored(personId),
	})
	// The API token itself is nowhere in the link.
	expect(result.url).not.toContain('token-1')
})

test('appOpenLink resolves package_id and hosted URLs to the app host', async () => {
	allowVisit()
	mockModule.getSavedPackageByIdInAnyOrg.mockResolvedValue({
		id: 'package-1',
		userId: 'org-acme',
		name: '@acme/demo-app',
	})
	mockModule.getOrgById.mockResolvedValue({ id: 'org-acme', slug: 'acme' })
	for (const args of [
		{ package_id: 'package-1' },
		{ app: 'https://heykody.dev/@acme/demo-app' },
	]) {
		const result = await openLink(args)
		expect(new URL(result.url).origin).toBe(
			'https://demo-app--acme.apps.example.com',
		)
		await expect(exchange(result.url)).resolves.toMatchObject({
			kodyId: 'demo-app',
		})
	}
})

test('appOpenLink mints for the host each hosted URL form is served on', async () => {
	allowVisit()
	const custom: Record<string, AppAddress> = {
		'https://demo.customer.example/cards?tab=2': {
			ownerHandle: 'acme',
			appSlug: 'demo-app',
			path: '/cards?tab=2',
			customMount: {
				baseUrl: 'https://demo.customer.example',
				mount: 'custom-hostname',
			},
		},
		'https://apps.customer.example/demo-app/cards?tab=2': {
			ownerHandle: 'acme',
			appSlug: 'demo-app',
			path: '/cards?tab=2',
			customMount: {
				baseUrl: 'https://apps.customer.example/demo-app',
				mount: 'user-subdomain',
			},
		},
	}
	mockModule.customDomainAddress.mockImplementation(
		(address) => custom[address] ?? null,
	)
	const forms = [
		{
			// The owner's shared host only redirects to the app's own host once
			// the path address is retired, so the link is minted for that host.
			app: 'https://acme.apps.example.com/demo-app/cards?tab=2',
			opens: 'https://demo-app--acme.apps.example.com/cards?tab=2',
			mount: 'custom-hostname',
		},
		{
			app: 'https://demo.customer.example/cards?tab=2',
			opens: 'https://demo.customer.example/cards?tab=2',
			mount: 'custom-hostname',
		},
		{
			app: 'https://apps.customer.example/demo-app/cards?tab=2',
			opens: 'https://apps.customer.example/demo-app/cards?tab=2',
			mount: 'user-subdomain',
		},
	]
	const tokens = new Map<string, string>()
	for (const form of forms) {
		const result = await openLink({ app: form.app })
		const link = new URL(result.url)
		tokens.set(
			link.host,
			link.searchParams.get(packageAppOpenLinkQueryParam) ?? '',
		)
		link.searchParams.delete(packageAppOpenLinkQueryParam)
		expect(link.toString()).toBe(form.opens)
		// The preflight runs the app's checks at the mount the browser will use.
		const preflight = mockModule.servePackageAppRequest.mock.lastCall?.[0] as {
			request: Request
			packagePath: { mount: string; restPath: string }
		}
		expect(preflight.request.url).toBe(form.opens)
		expect(preflight.packagePath).toMatchObject({
			mount: form.mount,
			restPath: '/cards',
		})
	}
	expect(tokens.size).toBe(3)

	silenceExpectedConsoleWarns(['Package app open link rejected.'])
	// Each link is for its own host: the other two refuse it, then its own
	// host still accepts it once.
	for (const [mintedFor, token] of tokens) {
		for (const host of tokens.keys()) {
			if (host === mintedFor) continue
			await expect(
				consumePackageAppOpenLinkToken({
					env,
					token,
					expected: { username: 'acme', kodyId: 'demo-app', host },
				}),
			).resolves.toBeNull()
		}
		await expect(
			consumePackageAppOpenLinkToken({
				env,
				token,
				expected: { username: 'acme', kodyId: 'demo-app', host: mintedFor },
			}),
		).resolves.toMatchObject({ host: mintedFor })
	}
})

test('appOpenLink mints nothing for a refused app, a blocked profile, or a missing consent', async () => {
	silenceExpectedConsoleWarns(['Package app open link rejected.'])
	mockModule.authorizeAppVisit.mockResolvedValue({ kind: 'not-found' })
	await expect(openLink({ app: '@acme/demo-app' })).rejects.toThrow(
		/No app at "@acme\/demo-app" that you can run/,
	)
	mockModule.authorizeAppVisit.mockResolvedValue({
		kind: 'forbidden',
		owner: { userId: 'org-acme', username: 'acme', displayName: 'Acme' },
		app: null,
		error: Object.assign(new Error('The profile has no Use on this app.'), {
			code: 'profile_grant',
		}),
	})
	await expect(
		openLink({ app: '@acme/demo-app' }, { profileId: 'prf_research' }),
	).rejects.toThrow('The profile has no Use on this app.')
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()

	// Run as me: reported before anything is served, like appFetch.
	allowVisit({ needsRunConsent: true })
	const runAsMe = await openLink({ app: '@acme/demo-app' }).catch((e) => e)
	expect(runAsMe).toBeInstanceOf(AppConsentRequiredError)
	expect(runAsMe).toMatchObject({
		code: 'app_consent_required',
		consent: 'run_as_me',
	})
	expect(runAsMe.consentUrl).toContain('https://heykody.dev/')
	expect(runAsMe.message).not.toContain(packageAppOpenLinkQueryParam)
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()

	// A required visitor credential: found by the preflight, not by the app.
	allowVisit()
	const consentUrl =
		'https://demo-app--acme.apps.example.com/-/auth/login?app=demo-app&scope=profile+need%3Agithub'
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(JSON.stringify({ need: 'github', consent_url: consentUrl }), {
			status: 403,
			headers: { 'X-Kody-Visitor-Consent': 'required' },
		}),
	)
	const need = await openLink({ app: '@acme/demo-app' }).catch((e) => e)
	expect(need).toBeInstanceOf(AppConsentRequiredError)
	expect(need).toMatchObject({
		consent: 'visitor_need',
		need: 'github',
		consentUrl,
	})

	// Run as me withdrawn between the check and the preflight.
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(null, {
			status: 403,
			headers: { 'X-Kody-Run-As-Me': 'required' },
		}),
	)
	await expect(openLink({ app: '@acme/demo-app' })).rejects.toMatchObject({
		consent: 'run_as_me',
	})

	// The package is there but serves no app.
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response('not found', { status: 404 }),
	)
	await expect(openLink({ app: '@acme/demo-app' })).rejects.toThrow(
		/No app at "@acme\/demo-app" that you can run/,
	)
})

test('appOpenLink mints nothing when the app host would refuse the browser, and links to anything it would serve', async () => {
	// A refusal with no consent to give, such as a profile credential the
	// profile cannot use.
	allowVisit()
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response('This app needs a credential the profile cannot use.', {
			status: 403,
		}),
	)
	await expect(openLink({ app: '@acme/demo-app' })).rejects.toThrow(
		'the app host refused the visit with 403. This app needs a credential the profile cannot use.',
	)

	// Kody's own paths on the app host are answered before any exchange.
	mockModule.servePackageAppRequest.mockClear()
	await expect(
		openLink({ app: '@acme/demo-app', path: '/-/health' }),
	).rejects.toThrow('/- is a Kody path on the app host')
	await expect(
		openLink({ app: '@acme/demo-app', path: '/_kody/auth/me' }),
	).rejects.toThrow('/_kody/auth is a Kody path on the app host')
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()

	// A static asset is served without running the app: still a page to open.
	for (const path of ['/_assets/logo.svg', '/robots.txt', '/_kody/help']) {
		mockModule.servePackageAppRequest.mockResolvedValue(
			new Response('asset', { status: 200 }),
		)
		const result = await openLink({ app: '@acme/demo-app', path })
		expect(new URL(result.url).pathname).toBe(path)
	}
})

test('appOpenLink refuses runtime callers, bad input, and a deployment with no app host', async () => {
	allowVisit()
	await expect(
		openLink({ app: '@acme/demo-app' }, { packageId: 'package-1' }),
	).rejects.toThrow(/Package app and job code cannot call it/)
	await expect(
		openLink({ app: '@acme/demo-app', path: '/../admin' }),
	).rejects.toThrow(/parent traversal/)
	await expect(
		openLink({ app: '@acme/demo-app', path: '/?__kody_open_link=x' }),
	).rejects.toThrow(/must not carry/)

	// Apps served on the Kody origin itself would put the visit cookie there.
	mockModule.getPackageAppBaseUrl.mockReturnValueOnce(null)
	await expect(openLink({ app: '@acme/demo-app' })).rejects.toThrow(
		/needs apps served on their own host/,
	)
})

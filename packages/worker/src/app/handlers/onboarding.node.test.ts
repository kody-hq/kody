import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	readOnboardingPageData,
	loadOnboardingCustomMcpServers,
	loadOnboardingFeaturedMcpServers,
	loadPersistedPackageName,
} from '#app/handlers/onboarding.ts'
import { onboardingIndexRedirectHref } from '#universal/onboarding-process.ts'
import { type OnboardingLoaderData } from '#universal/loader-data.ts'
import type * as McpServersShared from '#mcp/capabilities/mcp-servers/shared.ts'
import type * as OnboardingChecklist from '#mcp/onboarding-checklist.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	listMcpServerSettings: vi.fn(),
	loadMcpClientHubReadSnapshotOrNull: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadOnboardingAccessWin: vi.fn<
		typeof OnboardingChecklist.loadOnboardingAccessWin
	>(async () => false),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	listFeaturedCommunityListingsWithAggregates: vi.fn(async () => []),
	getCommunityListingWithAggregates: vi.fn(async () => null),
	getCommunityListingsByIds: vi.fn(async () => []),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/onboarding-checklist.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OnboardingChecklist>()
	return {
		...actual,
		loadOnboardingAccessWin: (
			...args: Parameters<typeof actual.loadOnboardingAccessWin>
		) => mockModule.loadOnboardingAccessWin(...args),
	}
})

vi.mock('#mcp/capabilities/mcp-servers/shared.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof McpServersShared>()
	return {
		...actual,
		loadMcpClientHubReadSnapshotOrNull: (...args: Array<unknown>) =>
			mockModule.loadMcpClientHubReadSnapshotOrNull(...args),
	}
})

function makeEnv(overrides: Record<string, unknown> = {}) {
	setAuthSessionSecret(testCookieSecret)
	return { COOKIE_SECRET: testCookieSecret, ...overrides } as Env
}

function signIn(emailVerified = true) {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		username: 'u-b',
		emailVerified,
		mcpUser: { userId: ownerIdFromStored('user-1') },
	})
}

function fetchApi(env: Env) {
	return readOnboardingPageData(
		env,
		new Request('https://example.com/onboarding'),
	)
}

function mcpServer(id: string, name: string, url: string) {
	return {
		id,
		name,
		url,
		enabled: true,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		usageMode: 'any',
		allowedPackageIds: [],
	}
}

function hubReady(serverId: string, tool: string) {
	return {
		servers: [
			{
				serverId,
				state: 'ready',
				authorizationPending: false,
				error: null,
				tools: [{ name: tool }],
			},
		],
	}
}

function expectDisconnectedFeaturedCatalog(
	servers: OnboardingLoaderData['featuredMcpServers'],
) {
	expect(servers.map((server) => server.id)).toContain('notion')
	expect(
		servers.every((server) => !server.connected && server.serverId === null),
	).toBe(true)
}

test('anonymous onboarding API is publicly cacheable setup content with a disconnected featured catalog', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await fetchApi(makeEnv())
	expect(new Headers(response.headers).get('Cache-Control')).toBe(
		'public, max-age=60, stale-while-revalidate=300',
	)
	expect(new Headers(response.headers).get('Vary')).toBe('Cookie')
	expect(response.serverTiming.map((entry) => entry.name)).toEqual(
		expect.arrayContaining(['listings', 'highlight']),
	)
	const payload = response.payload as OnboardingLoaderData
	expect(payload).toMatchObject({
		ok: true,
		loggedIn: false,
		mcpServerUrl: 'https://example.com/mcp',
		needsOnboarding: true,
		persistedPackageName: null,
		accessWinMemorySubject: null,
	})
	expect(payload.setupPrompt.length).toBeGreaterThan(0)
	expect(payload.discoveryPrompt).toContain('https://example.com')
	expectDisconnectedFeaturedCatalog(payload.featuredMcpServers)
})

test('signed-in /onboarding resumes at the unfinished wizard step', async () => {
	signIn()
	const grants = vi.fn(async () => ({
		items: [] as Array<{ id: string; clientId: string }>,
	}))
	const env = makeEnv({ OAUTH_PROVIDER: { listUserGrants: grants } })
	const resume = async (search = '') =>
		onboardingIndexRedirectHref(
			search,
			(
				await readOnboardingPageData(
					env,
					new Request(`https://example.com/onboarding${search}`),
				)
			).payload,
		)
	expect(await resume()).toBe('/onboarding/step-1')

	grants.mockResolvedValue({
		items: [
			{ id: 'g1', clientId: 'cursor-client' },
			{ id: 'g2', clientId: 'claude-desktop-client' },
		],
	})
	expect(await resume()).toBe('/onboarding/step-2')

	mockModule.loadOnboardingAccessWin.mockResolvedValue(true)
	expect(await resume('?redirectTo=%2F')).toBe(
		'/onboarding/step-3?redirectTo=%2F',
	)

	signIn(false)
	expect(
		(
			await readOnboardingPageData(
				env,
				new Request('https://example.com/onboarding'),
			)
		).payload,
	).toMatchObject({ loggedIn: true, emailVerified: false })
})

test('onboarding featured MCP servers overlay Notion and Linear connection state', async () => {
	const env = {} as Env
	mockModule.listMcpServerSettings.mockResolvedValue([
		mcpServer('srv-linear', 'linear', 'https://mcp.linear.app/mcp'),
	])
	mockModule.loadMcpClientHubReadSnapshotOrNull.mockResolvedValue(
		hubReady('srv-linear', 'list_issues'),
	)

	expectDisconnectedFeaturedCatalog(await loadOnboardingFeaturedMcpServers(env))
	expect(mockModule.listMcpServerSettings).not.toHaveBeenCalled()

	const signedIn = await loadOnboardingFeaturedMcpServers(
		env,
		ownerIdFromStored('viewer-1'),
	)
	expect(signedIn[0]).toMatchObject({
		id: 'notion',
		connected: false,
		serverId: null,
	})
	expect(signedIn[1]).toMatchObject({
		id: 'linear',
		connected: true,
		serverId: 'srv-linear',
		state: 'ready',
	})
	expect(mockModule.listMcpServerSettings).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('viewer-1'),
	})

	mockModule.listMcpServerSettings.mockRejectedValue(new Error('d1 blip'))
	expectDisconnectedFeaturedCatalog(
		await loadOnboardingFeaturedMcpServers(env, ownerIdFromStored('viewer-1')),
	)
})

test('onboarding custom MCP servers exclude featured remotes', async () => {
	const env = {} as Env
	mockModule.listMcpServerSettings.mockResolvedValue([
		mcpServer('srv-linear', 'linear', 'https://mcp.linear.app/mcp'),
		mcpServer('srv-acme', 'acme', 'https://mcp.acme.example/mcp'),
	])
	mockModule.loadMcpClientHubReadSnapshotOrNull.mockResolvedValue(
		hubReady('srv-acme', 'ping'),
	)

	await expect(loadOnboardingCustomMcpServers(env)).resolves.toEqual([])
	await expect(
		loadOnboardingCustomMcpServers(env, ownerIdFromStored('viewer-1')),
	).resolves.toEqual([
		{
			id: 'srv-acme',
			name: 'acme',
			url: 'https://mcp.acme.example/mcp',
			connected: true,
			authorizationPending: false,
			state: 'ready',
			error: null,
		},
	])
})

test('onboarding persist chrome uses the newest saved-package name in the private signed-in API payload', async () => {
	const env = makeEnv({ APP_DB: {} })
	const newest = { name: '@u-b/morning-digest', kodyId: 'morning-digest' }

	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		newest,
		{ name: '@u-b/older-package', kodyId: 'older-package' },
	])
	await expect(
		loadPersistedPackageName(env, ownerIdFromStored('user-1')),
	).resolves.toBe(newest.name)
	expect(mockModule.listSavedPackagesByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		{ userId: ownerIdFromStored('user-1') },
	)

	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	await expect(
		loadPersistedPackageName(env, ownerIdFromStored('user-1')),
	).resolves.toBeNull()

	mockModule.listSavedPackagesByUserId.mockRejectedValue(new Error('d1 blip'))
	await expect(
		loadPersistedPackageName(env, ownerIdFromStored('user-1')),
	).resolves.toBeNull()

	mockModule.listSavedPackagesByUserId.mockResolvedValue([newest])
	mockModule.listMcpServerSettings.mockResolvedValue([])
	for (const [emailVerified, persistedPackageName] of [
		[false, null],
		[true, newest.name],
	] as const) {
		signIn(emailVerified)
		const response = await fetchApi(env)
		expect(response.headers).toBeUndefined()
		expect(response.payload).toMatchObject({
			ok: true,
			loggedIn: true,
			username: 'u-b',
			persistedPackageName,
			accessWinMemorySubject: null,
		})
	}
})

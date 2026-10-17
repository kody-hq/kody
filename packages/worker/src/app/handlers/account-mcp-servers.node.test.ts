import type * as authSession from '#app/auth-session.ts'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as authorizeModule from '#worker/authorization/authorize.ts'
import type * as ProviderMarks from '#worker/integrations/provider-marks.ts'
import type * as hubClient from '#worker/mcp-client/hub-client.ts'
import { type McpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import type * as settingsRepo from '#worker/mcp-client/settings-repo.ts'
import type * as settingsService from '#worker/mcp-client/settings-service.ts'
import { type McpServerSettingMetadata } from '#worker/mcp-client/settings-types.ts'
import { type McpServerLastError } from '#worker/mcp-client/types.ts'
import type * as orgsRepo from '#worker/orgs/repo.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'

const mockModule = await vi.hoisted(async () => {
	// Hoisted above static imports, so the id helpers load here.
	const { personIdFromStored } =
		await import('@kody-internal/shared/owner-person-ids.ts')
	const { sessionRequestContext } =
		await import('#worker/test-support/request-context.ts')
	const epoch = new Date(0).toISOString()
	const setting = (
		overrides: Partial<McpServerSettingMetadata> = {},
	): McpServerSettingMetadata => ({
		id: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		enabled: true,
		createdAt: epoch,
		updatedAt: epoch,
		logoKey: null,
		logoContentType: null,
		logoSource: null,
		faviconSourceHost: null,
		usageMode: 'any',
		allowedPackageIds: [],
		lastError: null,
		...overrides,
	})
	const mcpUser = {
		userId: personIdFromStored('stable-user-1'),
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	}
	return {
		epoch,
		hubOwners: [] as Array<string>,
		getMcpServerOwnerId: vi.fn<typeof settingsRepo.getMcpServerOwnerId>(
			async () => null,
		),
		loadOrgBindingForOrg: vi.fn<typeof orgsRepo.loadOrgBindingForOrg>(
			async () => null,
		),
		authorize: vi.fn<typeof authorizeModule.authorize>(async () => {}),
		waitUntil: vi.fn<typeof CloudflareWorkers.waitUntil>(),
		readAuthenticatedAppUser: vi.fn<
			typeof authenticatedUserModule.readAuthenticatedAppUser
		>(async () => ({
			sessionUserId: '42',
			userId: 42,
			username: 'test-user',
			email: 'user@example.com',
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: 'user',
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [],
			mcpUser,
			request: sessionRequestContext(mcpUser.userId),
		})),
		readAuthSessionResult: vi.fn<typeof authSession.readAuthSessionResult>(
			async () => ({
				session: {
					stableUserId: ownerIdFromStored('stable-user-1'),
					email: 'user@example.com',
					rememberMe: false,
				},
				setCookie: null,
			}),
		),
		listMcpServerSettings: vi.fn<typeof settingsService.listMcpServerSettings>(
			async () => [setting()],
		),
		getMcpServerSettingById: vi.fn<
			typeof settingsService.getMcpServerSettingById
		>(async () => setting()),
		addMcpServer: vi.fn<typeof settingsService.addMcpServer>(async () => ({
			setting: setting({
				id: 'server-2',
				name: 'notion',
				url: 'https://mcp.notion.example/mcp',
			}),
			connection: {
				serverId: 'server-2',
				state: 'authenticating',
				authorizationPending: true,
				error: null,
				toolCount: 0,
			},
		})),
		setMcpServerEnabled: vi.fn<typeof settingsService.setMcpServerEnabled>(
			async () => setting({ enabled: false }),
		),
		setMcpServerUsage: vi.fn<typeof settingsService.setMcpServerUsage>(
			async () =>
				setting({ usageMode: 'packages', allowedPackageIds: ['pkg-drafts'] }),
		),
		deleteMcpServer: vi.fn<typeof settingsService.deleteMcpServer>(
			async () => true,
		),
		setMcpServerLastError: vi.fn<typeof settingsService.setMcpServerLastError>(
			async () => true,
		),
		persistMcpServerLastErrorIfChanged: vi.fn<
			typeof settingsService.persistMcpServerLastErrorIfChanged
		>(async () => undefined),
		getCachedMcpClientHubReadSnapshot: vi.fn<
			typeof hubClient.getCachedMcpClientHubReadSnapshot
		>(async () => ({
			servers: [
				{
					serverId: 'server-1',
					name: 'linear',
					url: 'https://mcp.example.com/mcp',
					state: 'ready',
					authorizationPending: false,
					error: null,
					instructions: null,
					tools: [
						{ name: 'create_issue', inputSchema: { type: 'object' } },
						{ name: 'list_issues', inputSchema: { type: 'object' } },
					],
				},
			],
		})),
		handleOAuthCallback: vi.fn<McpClientHubClient['handleOAuthCallback']>(
			async () => ({
				serverId: 'server-1',
				authSuccess: true,
				authError: null,
				serverName: 'linear',
				authorizationNeeded: false,
				lastError: null,
			}),
		),
		reconnectServer: vi.fn<McpClientHubClient['reconnectServer']>(async () => ({
			serverId: 'server-1',
			state: 'authenticating',
			authorizationPending: true,
			error: null,
			toolCount: 0,
		})),
	}
})

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		waitUntil: (...args: Parameters<typeof CloudflareWorkers.waitUntil>) =>
			mockModule.waitUntil(...args),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (
		...args: Parameters<typeof authSession.readAuthSessionResult>
	) => mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listMcpServerSettings: (
		...args: Parameters<typeof settingsService.listMcpServerSettings>
	) => mockModule.listMcpServerSettings(...args),
	getMcpServerSettingById: (
		...args: Parameters<typeof settingsService.getMcpServerSettingById>
	) => mockModule.getMcpServerSettingById(...args),
	addMcpServer: (...args: Parameters<typeof settingsService.addMcpServer>) =>
		mockModule.addMcpServer(...args),
	setMcpServerEnabled: (
		...args: Parameters<typeof settingsService.setMcpServerEnabled>
	) => mockModule.setMcpServerEnabled(...args),
	setMcpServerUsage: (
		...args: Parameters<typeof settingsService.setMcpServerUsage>
	) => mockModule.setMcpServerUsage(...args),
	deleteMcpServer: (
		...args: Parameters<typeof settingsService.deleteMcpServer>
	) => mockModule.deleteMcpServer(...args),
	setMcpServerLastError: (
		...args: Parameters<typeof settingsService.setMcpServerLastError>
	) => mockModule.setMcpServerLastError(...args),
	persistMcpServerLastErrorIfChanged: (
		...args: Parameters<
			typeof settingsService.persistMcpServerLastErrorIfChanged
		>
	) => mockModule.persistMcpServerLastErrorIfChanged(...args),
	resolveMcpServerOAuthClientUrls: (input: {
		env: { APP_BASE_URL?: string | null }
		requestUrl?: string | URL | null
	}) => {
		const configured = input.env.APP_BASE_URL?.trim()
		const clientOrigin = configured
			? new URL(configured).origin
			: new URL(String(input.requestUrl ?? 'https://heykody.app')).origin
		return {
			clientOrigin,
			callbackUrl: `${clientOrigin}/account/mcp-servers/oauth/callback`,
			clientMetadataUrl: clientOrigin.startsWith('https:')
				? `${clientOrigin}/oauth/client-metadata.json`
				: null,
		}
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: async () => [
		{ id: 'pkg-drafts', kodyId: 'gmail-drafts' },
	],
}))

vi.mock('#worker/integrations/provider-marks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof ProviderMarks>()
	return {
		...actual,
		listPlatformProviderMarks: async () => [],
	}
})

vi.mock('#worker/mcp-client/settings-repo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof settingsRepo>()),
	getMcpServerOwnerId: (
		...args: Parameters<typeof settingsRepo.getMcpServerOwnerId>
	) => mockModule.getMcpServerOwnerId(...args),
}))

vi.mock('#worker/orgs/repo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof orgsRepo>()),
	loadOrgBindingForOrg: (
		...args: Parameters<typeof orgsRepo.loadOrgBindingForOrg>
	) => mockModule.loadOrgBindingForOrg(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<typeof authorizeModule>()),
	authorize: (...args: Parameters<typeof authorizeModule.authorize>) =>
		mockModule.authorize(...args),
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	getCachedMcpClientHubReadSnapshot: (
		...args: Parameters<typeof hubClient.getCachedMcpClientHubReadSnapshot>
	) => mockModule.getCachedMcpClientHubReadSnapshot(...args),
	createMcpClientHubClient: (input: { userId: string }) => {
		mockModule.hubOwners.push(input.userId)
		return {
			handleOAuthCallback: (
				...args: Parameters<McpClientHubClient['handleOAuthCallback']>
			) => mockModule.handleOAuthCallback(...args),
			reconnectServer: (
				...args: Parameters<McpClientHubClient['reconnectServer']>
			) => mockModule.reconnectServer(...args),
			refreshServer: vi.fn(async () => ({
				serverId: 'server-1',
				state: 'ready',
				authorizationPending: false,
				error: null,
				toolCount: 2,
			})),
		}
	},
}))

const {
	testAccountMcpServersApiHandler,
	createAccountMcpServersOauthCallbackHandler,
} = await import('./account-mcp-servers.test-support.ts')

const env = { APP_DB: {} as D1Database } as Env
const apiUrl = 'https://example.com/account/mcp-servers.json'
const callbackUrl = 'https://example.com/account/mcp-servers/oauth/callback'
const userScope = {
	userId: ownerIdFromStored('stable-user-1'),
	id: 'server-1',
}

function discoveryFailure(attemptId: string, suffix = '') {
	const message = `Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, mcp https://mcp.example.com/mcp, id ${attemptId}).${suffix}`
	const lastError: McpServerLastError = {
		message,
		phase: 'server/discover',
		httpStatus: null,
		httpBodySnippet: null,
		mcpEndpoint: 'https://mcp.example.com/mcp',
		resource: null,
		authServer: null,
		attemptId,
		at: '2026-09-08T00:00:00.000Z',
	}
	return { message, lastError }
}

function createApiClient() {
	const { execute } = testAccountMcpServersApiHandler(env)
	return {
		get: () => execute({ request: new Request(apiUrl), params: {} } as never),
		post: (body: Record<string, unknown>) =>
			execute({
				request: new Request(apiUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				params: {},
			} as never),
	}
}

function createCallbackClient() {
	const handler = createAccountMcpServersOauthCallbackHandler(env)
	return async (search: string, init?: RequestInit) => {
		const response = await handler({
			request: new Request(`${callbackUrl}?${search}`, init),
			params: {},
		} as never)
		return {
			response,
			location: new URL(
				new Headers(response.headers).get('Location') ?? '',
				callbackUrl,
			),
		}
	}
}

test('MCP servers API lists, adds, reconnects, disables, and deletes with user scope', async () => {
	const { get, post } = createApiClient()

	const listResponse = await get()
	expect(listResponse.status).toBe(200)
	expect(listResponse.data).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		oauthClientOrigin: 'https://example.com',
		oauthCallbackUrl: callbackUrl,
		oauthClientMetadataUrl: 'https://example.com/oauth/client-metadata.json',
		servers: [
			{
				id: 'server-1',
				name: 'linear',
				url: 'https://mcp.example.com/mcp',
				enabled: true,
				state: 'ready',
				connected: true,
				toolCount: 2,
				authUrl: null,
				error: null,
				hasRefreshToken: false,
				tools: ['create_issue', 'list_issues'],
				createdAt: mockModule.epoch,
				updatedAt: mockModule.epoch,
				autoLogoPath: null,
				catalogLogoPath: null,
				usageMode: 'any',
				allowedPackageIds: [],
				oauthClientId: null,
			},
		],
		savedPackages: [{ id: 'pkg-drafts', kodyId: 'gmail-drafts' }],
	})

	const listImplementation =
		mockModule.listMcpServerSettings.getMockImplementation()!
	// Accepted writes must not depend on rebuilding the settings page.
	mockModule.listMcpServerSettings.mockClear()
	mockModule.listMcpServerSettings.mockRejectedValue(
		new Error('List unavailable'),
	)

	const addResponse = await post({
		action: 'add',
		name: 'notion',
		url: 'https://mcp.notion.example/mcp',
		bearerToken: 'secret-token',
	})
	expect(addResponse.status).toBe(200)
	expect(mockModule.addMcpServer).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			personId: ownerIdFromStored('stable-user-1'),
			name: 'notion',
			url: 'https://mcp.notion.example/mcp',
			baseUrl: 'https://example.com',
			bearerToken: 'secret-token',
			waitUntil: expect.any(Function),
		}),
	)
	expect(addResponse.data).toMatchObject({
		ok: true,
		selectedServerId: 'server-2',
	})

	const reconnectResponse = await post({ action: 'reconnect', id: 'server-1' })
	expect(reconnectResponse.status).toBe(200)
	expect(mockModule.reconnectServer).toHaveBeenCalledWith({
		serverId: 'server-1',
		callbackUrl,
		actor: {
			ownerOrgId: ownerIdFromStored('stable-user-1'),
			personId: ownerIdFromStored('stable-user-1'),
		},
	})

	const hung = discoveryFailure('attempt-reconnect')
	mockModule.reconnectServer.mockResolvedValueOnce({
		serverId: 'server-1',
		state: 'connected',
		authorizationPending: false,
		error: hung.message,
		toolCount: 0,
		lastError: hung.lastError,
	})
	const hungReconnect = await post({ action: 'reconnect', id: 'server-1' })
	expect(hungReconnect.status).toBe(200)
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			lastError: expect.objectContaining({
				phase: 'server/discover',
				attemptId: 'attempt-reconnect',
			}),
		}),
	)

	const disableResponse = await post({
		action: 'set-enabled',
		id: 'server-1',
		enabled: false,
	})
	expect(disableResponse.status).toBe(200)
	expect(mockModule.setMcpServerEnabled).toHaveBeenCalledWith(
		expect.objectContaining({ ...userScope, enabled: false }),
	)

	const usageResponse = await post({
		action: 'set-usage',
		id: 'server-1',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-drafts'],
	})
	expect(usageResponse.status).toBe(200)
	expect(mockModule.setMcpServerUsage).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
		}),
	)

	const deleteResponse = await post({ action: 'delete', id: 'server-1' })
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteMcpServer).toHaveBeenCalledWith(
		expect.objectContaining(userScope),
	)
	mockModule.listMcpServerSettings.mockImplementation(listImplementation)
	expect(mockModule.listMcpServerSettings).not.toHaveBeenCalled()
	expect(addResponse.data).not.toHaveProperty('servers')
	expect(hungReconnect.data).toMatchObject({
		state: 'connected',
		error: hung.message,
		toolCount: 0,
	})
})

test('MCP servers OAuth callback ignores HEAD and redirects with the auth outcome', async () => {
	const callback = createCallbackClient()

	const head = await callback('code=abc&state=xyz', { method: 'HEAD' })
	expect(head.response.status).toBe(200)
	expect(mockModule.handleOAuthCallback).not.toHaveBeenCalled()

	const success = await callback('code=abc&state=xyz')
	expect(success.response.status).toBe(303)
	expect(success.location.pathname).toBe('/@test-user/-/mcp-servers/server-1')
	expect(success.location.searchParams.get('auth')).toBe('success')
	expect(success.location.searchParams.get('server')).toBe('linear')
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({ ...userScope, lastError: null }),
	)

	const onboarding = await callback('code=abc&state=xyz', {
		headers: { Cookie: 'kody_mcp_oauth_return=onboarding' },
	})
	expect(onboarding.response.status).toBe(303)
	expect(onboarding.location.pathname).toBe('/onboarding/step-2')
	expect(onboarding.location.hash).toBe('')
	expect(onboarding.location.searchParams.get('auth')).toBe('success')
	const onboardingSetCookie =
		new Headers(onboarding.response.headers).get('Set-Cookie') ?? ''
	expect(onboardingSetCookie).toContain('kody_mcp_oauth_return=;')
	expect(onboardingSetCookie).toContain('Max-Age=0')
	expect(mockModule.handleOAuthCallback).toHaveBeenCalledWith({
		url: `${callbackUrl}?code=abc&state=xyz`,
		callbackUrl,
		actor: {
			ownerOrgId: ownerIdFromStored('stable-user-1'),
			personId: ownerIdFromStored('stable-user-1'),
		},
	})

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: null,
		authSuccess: false,
		authError: 'Invalid state.',
		serverName: null,
		authorizationNeeded: false,
		lastError: null,
	})
	const failure = await callback('error=access_denied')
	expect(failure.response.status).toBe(303)
	expect(failure.location.pathname).toBe('/@test-user/-/mcp-servers')
	expect(failure.location.searchParams.get('auth')).toBe('error')
	expect(failure.location.searchParams.get('reason')).toBe('Invalid state.')

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Invalid origin uri https://example.com',
		serverName: 'linear',
		authorizationNeeded: false,
		lastError: null,
	})
	const originFailure = await callback('error=invalid_origin')
	expect(originFailure.response.status).toBe(303)
	expect(originFailure.location.searchParams.get('auth')).toBe('error')
	expect(originFailure.location.searchParams.get('reason')).toContain(
		'https://example.com/oauth/client-metadata.json',
	)

	const authorizationNeeded =
		'Authorization needed. Reconnect the MCP server and approve access once more.'
	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: authorizationNeeded,
		serverName: 'linear',
		authorizationNeeded: true,
		lastError: null,
	})
	const recovery = await callback('code=abc&state=used.server-1')
	expect(recovery.response.status).toBe(303)
	expect(recovery.location.pathname).toBe('/@test-user/-/mcp-servers/server-1')
	expect(recovery.location.searchParams.get('auth')).toBe('required')
	expect(recovery.location.searchParams.has('reason')).toBe(false)

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: null,
		authSuccess: false,
		authError: authorizationNeeded,
		serverName: null,
		authorizationNeeded: true,
		lastError: null,
	})
	const unknownRecovery = await callback('error=access_denied')
	expect(unknownRecovery.location.pathname).toBe('/@test-user/-/mcp-servers')
	expect(unknownRecovery.location.searchParams.get('auth')).toBe('retry')
	expect(unknownRecovery.location.searchParams.has('reason')).toBe(false)

	const settle = discoveryFailure(
		'attempt-1',
		' Reconnect it from /@test-user/-/mcp-servers.',
	)
	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: settle.message,
		serverName: 'linear',
		authorizationNeeded: false,
		lastError: settle.lastError,
	})
	const settleFailure = await callback('code=abc&state=ok.server-1')
	expect(settleFailure.location.searchParams.get('auth')).toBe('error')
	expect(settleFailure.location.searchParams.get('reason')).toContain(
		"tool discovery didn't finish",
	)
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			lastError: expect.objectContaining({
				phase: 'server/discover',
				attemptId: 'attempt-1',
			}),
		}),
	)
})

test('the OAuth callback finishes in the org that owns the server when the person can write its integrations', async () => {
	const { AuthorizationError } =
		await import('#worker/authorization/authorize.ts')
	const acmeId = ownerIdFromStored('org-acme')
	const callback = createCallbackClient()
	mockModule.getMcpServerOwnerId.mockResolvedValue(acmeId)
	mockModule.loadOrgBindingForOrg.mockResolvedValue({
		org: { id: acmeId, slug: 'acme' },
		role: 'member',
	})
	mockModule.hubOwners.length = 0
	mockModule.setMcpServerLastError.mockClear()

	const team = await callback('code=abc&state=nonce.server-1')
	expect(mockModule.getMcpServerOwnerId).toHaveBeenCalledWith(
		expect.objectContaining({ id: 'server-1' }),
	)
	expect(mockModule.authorize).toHaveBeenCalledWith(
		expect.objectContaining({
			request: expect.objectContaining({
				org: expect.objectContaining({ id: acmeId }),
			}),
		}),
		'integration:write',
	)
	expect(mockModule.hubOwners).toEqual([acmeId])
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: acmeId,
			id: 'server-1',
			lastError: null,
		}),
	)
	expect(team.location.pathname).toBe('/@acme/-/mcp-servers/server-1')
	expect(team.location.searchParams.get('auth')).toBe('success')

	// Without integration:write there, or without access to the org, the
	// callback stays in the session's org, as before.
	mockModule.authorize.mockRejectedValueOnce(
		new AuthorizationError({
			code: 'missing_permission',
			permission: 'integration:write',
			orgId: acmeId,
			resource: null,
			message: 'Missing integration:write',
		}),
	)
	await callback('code=abc&state=nonce.server-1')
	mockModule.loadOrgBindingForOrg.mockResolvedValueOnce(null)
	await callback('code=abc&state=nonce.server-1')
	mockModule.getMcpServerOwnerId.mockResolvedValueOnce(null)
	const unknown = await callback('code=abc&state=nonce.server-9')
	mockModule.getMcpServerOwnerId.mockRejectedValueOnce(new Error('D1 down'))
	const lookupFailed = await callback('code=abc&state=nonce.server-1')
	expect(mockModule.hubOwners.slice(1)).toEqual([
		userScope.userId,
		userScope.userId,
		userScope.userId,
		userScope.userId,
	])
	expect(unknown.location.pathname).toBe('/@test-user/-/mcp-servers/server-1')
	expect(lookupFailed.response.status).toBe(303)
	expect(lookupFailed.location.pathname).toBe(
		'/@test-user/-/mcp-servers/server-1',
	)

	mockModule.getMcpServerOwnerId.mockResolvedValue(null)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
})

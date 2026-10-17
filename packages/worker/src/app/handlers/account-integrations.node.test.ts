import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as secretsService from '#mcp/secrets/service.ts'
import type * as IntegrationsCredentials from '#worker/integrations/credentials.ts'
import type * as IntegrationsRepo from '#worker/integrations/repo.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import type * as PackageRegistryRepo from '#worker/package-registry/repo.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => {
	const stamps = {
		createdAt: '1970-01-01T00:00:00.000Z',
		updatedAt: '1970-01-01T00:00:00.001Z',
	}
	const googleApp = {
		userId: 'stable-user-1' as OwnerId,
		slug: 'google',
		provider: 'google',
		label: null,
		clientId: 'shared-google-client',
		hasClientSecret: true,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		deviceAuthorizationUrl: null,
		apiBaseUrl: 'https://www.googleapis.com' as string | null,
		flow: 'pkce' as 'pkce' | 'confidential',
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' } as Record<string, string>,
		...stamps,
	}
	const githubApp = {
		...googleApp,
		slug: 'github',
		provider: 'github',
		clientId: 'github-client-id-value',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		deviceAuthorizationUrl: null,
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential' as const,
		extraAuthorizeParams: {},
	}
	const joined = (
		app: typeof googleApp,
		name: string,
		accountLabel: string | null,
		scopes: Array<string>,
	) => ({
		lane: 'user' as const,
		app,
		connection: {
			userId: 'stable-user-1' as OwnerId,
			credentialId: 'cred-integration',
			name,
			appSlug: app.slug,
			platformAppSlug: null,
			accountLabel,
			description: '',
			scopes,
			requiredHosts: [new URL(app.apiBaseUrl ?? '').host],
			usageMode: 'any' as const,
			allowedPackageIds: [] as Array<string>,
			connectedAt: null,
			tokenRefreshedAt: null,
			...stamps,
		},
	})
	const githubJoined = joined(githubApp, 'github', null, ['repo', 'read:user'])
	return {
		googleApp,
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
			mcpUser: {
				userId: personIdFromStored('stable-user-1'),
				email: 'user@example.com',
				username: 'test-user',
				displayName: 'user',
			},
			request: sessionRequestContext('stable-user-1'),
		})),
		readAuthSessionResult: async () => ({ session: null, setCookie: null }),
		listJoinedIntegrations: vi.fn<
			typeof IntegrationsService.listJoinedIntegrations
		>(async () => [
			joined(googleApp, 'google', 'Personal', ['openid', 'email']),
			joined(googleApp, 'google-calendar', 'Work calendar', [
				'calendar.readonly',
			]),
			githubJoined,
		]),
		getJoinedIntegration: vi.fn<
			typeof IntegrationsService.getJoinedIntegration
		>(async () => githubJoined),
		findOauthAppForProviderSetup: vi.fn<
			typeof IntegrationsService.findOauthAppForProviderSetup
		>(async () => null),
		listOauthApps: vi.fn<typeof IntegrationsService.listOauthApps>(async () => [
			{ ...githubApp, connectionCount: 1 },
			{ ...googleApp, connectionCount: 2 },
		]),
		getOauthApp: vi.fn<typeof IntegrationsService.getOauthApp>(
			async () => googleApp,
		),
		rotateOauthAppClientCredentials: vi.fn<
			typeof IntegrationsService.rotateOauthAppClientCredentials
		>(async () => ({
			...googleApp,
			clientId: 'shared-google-client-rotated',
			updatedAt: '1970-01-01T00:00:00.002Z',
		})),
		getAvailablePlatformApp: vi.fn<
			typeof IntegrationsService.getAvailablePlatformApp
		>(async () => null),
		listAvailablePlatformApps: vi.fn<
			typeof IntegrationsService.listAvailablePlatformApps
		>(async () => []),
		listSecrets: vi.fn<typeof secretsService.listSecrets>(async () => []),
		saveSecret: vi.fn<typeof secretsService.saveSecret>(async () => ({
			name: 'googleClientSecret',
			scope: 'user' as const,
			description: 'google OAuth client secret',
			packageId: null,
			allowedHosts: ['oauth2.googleapis.com'],
			allowedPackages: [],
			createdAt: '1970-01-01T00:00:00.002Z',
			updatedAt: '1970-01-01T00:00:00.002Z',
			expiresAt: null,
			ttlMs: null,
		})),
		setSecretAllowedHosts: vi.fn<typeof secretsService.setSecretAllowedHosts>(
			async (input) => ({
				name: input.name,
				scope: input.scope,
				description: '',
				packageId: null,
				allowedHosts: input.allowedHosts,
				allowedPackages: [],
				...stamps,
				expiresAt: null,
				ttlMs: null,
			}),
		),
		deleteIntegration: vi.fn<typeof IntegrationsService.deleteIntegration>(
			async () => true,
		),
		deleteOauthAppWithConnections: vi.fn<
			typeof IntegrationsService.deleteOauthAppWithConnections
		>(async () => ({
			deleted: true,
			connectionNames: ['google', 'google-calendar'],
		})),
		listSavedPackagesByUserId: vi.fn<
			typeof PackageRegistryRepo.listSavedPackagesByUserId
		>(async () => []),
		getOauthAppClientSecretCiphertext: vi.fn<
			typeof IntegrationsRepo.getOauthAppClientSecretCiphertext
		>(async () => null),
		persistUserOauthAppClientSecret: vi.fn<
			typeof IntegrationsCredentials.persistUserOauthAppClientSecret
		>(async () => undefined),
		setIntegrationUsage: vi.fn<typeof IntegrationsService.setIntegrationUsage>(
			async () => ({
				...joined(googleApp, 'google', 'Personal', []).connection,
				usageMode: 'packages',
				allowedPackageIds: ['pkg-mail'],
			}),
		),
		grantIntegrationPackage: vi.fn<
			typeof IntegrationsService.grantIntegrationPackage
		>(async () => ({
			...joined(googleApp, 'google', 'Personal', []).connection,
			usageMode: 'packages',
			allowedPackageIds: ['pkg-mail'],
		})),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: () => mockModule.readAuthSessionResult(),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listSecrets: (...args: Parameters<typeof secretsService.listSecrets>) =>
		mockModule.listSecrets(...args),
	saveSecret: (...args: Parameters<typeof secretsService.saveSecret>) =>
		mockModule.saveSecret(...args),
	setSecretAllowedHosts: (
		...args: Parameters<typeof secretsService.setSecretAllowedHosts>
	) => mockModule.setSecretAllowedHosts(...args),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsService>()
	return {
		...actual,
		listJoinedIntegrations: (
			...args: Parameters<typeof IntegrationsService.listJoinedIntegrations>
		) => mockModule.listJoinedIntegrations(...args),
		getJoinedIntegration: (
			...args: Parameters<typeof IntegrationsService.getJoinedIntegration>
		) => mockModule.getJoinedIntegration(...args),
		findOauthAppForProviderSetup: (
			...args: Parameters<
				typeof IntegrationsService.findOauthAppForProviderSetup
			>
		) => mockModule.findOauthAppForProviderSetup(...args),
		listOauthApps: (
			...args: Parameters<typeof IntegrationsService.listOauthApps>
		) => mockModule.listOauthApps(...args),
		getOauthApp: (
			...args: Parameters<typeof IntegrationsService.getOauthApp>
		) => mockModule.getOauthApp(...args),
		rotateOauthAppClientCredentials: (
			...args: Parameters<
				typeof IntegrationsService.rotateOauthAppClientCredentials
			>
		) => mockModule.rotateOauthAppClientCredentials(...args),
		deleteIntegration: (
			...args: Parameters<typeof IntegrationsService.deleteIntegration>
		) => mockModule.deleteIntegration(...args),
		deleteOauthAppWithConnections: (
			...args: Parameters<
				typeof IntegrationsService.deleteOauthAppWithConnections
			>
		) => mockModule.deleteOauthAppWithConnections(...args),
		getAvailablePlatformApp: (
			...args: Parameters<typeof IntegrationsService.getAvailablePlatformApp>
		) => mockModule.getAvailablePlatformApp(...args),
		listAvailablePlatformApps: (
			...args: Parameters<typeof IntegrationsService.listAvailablePlatformApps>
		) => mockModule.listAvailablePlatformApps(...args),
		setIntegrationUsage: (
			...args: Parameters<typeof IntegrationsService.setIntegrationUsage>
		) => mockModule.setIntegrationUsage(...args),
		grantIntegrationPackage: (
			...args: Parameters<typeof IntegrationsService.grantIntegrationPackage>
		) => mockModule.grantIntegrationPackage(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageRegistryRepo>()
	return {
		...actual,
		listSavedPackagesByUserId: (
			...args: Parameters<typeof PackageRegistryRepo.listSavedPackagesByUserId>
		) => mockModule.listSavedPackagesByUserId(...args),
	}
})

vi.mock('#worker/integrations/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsRepo>()
	return {
		...actual,
		getOauthAppClientSecretCiphertext: (
			...args: Parameters<
				typeof IntegrationsRepo.getOauthAppClientSecretCiphertext
			>
		) => mockModule.getOauthAppClientSecretCiphertext(...args),
	}
})

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsCredentials>()
	return {
		...actual,
		persistUserOauthAppClientSecret: (
			...args: Parameters<
				typeof IntegrationsCredentials.persistUserOauthAppClientSecret
			>
		) => mockModule.persistUserOauthAppClientSecret(...args),
	}
})

const { testAccountIntegrationsApiHandler } =
	await import('./account-integrations.test-support.ts')

function createEnv() {
	return {
		APP_DB: {
			prepare() {
				return {
					async all() {
						return { results: [] }
					},
					async first() {
						return null
					},
				}
			},
		} as unknown as D1Database,
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
}

const integrationsUrl = 'https://example.com/account/integrations.json'
const tokenFields = /"access_token"\s*:|"refresh_token"\s*:/
const withEnv = (input: Record<string, unknown>) => ({
	env: expect.any(Object),
	...input,
})

function createHandler() {
	const { execute } = testAccountIntegrationsApiHandler(createEnv())
	return {
		get: (search = '') =>
			execute({
				request: new Request(`${integrationsUrl}${search}`),
				params: {},
			} as never),
		post: (body: Record<string, unknown>) =>
			execute({
				request: new Request(integrationsUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				params: {},
			} as never),
	}
}

test('integrations API lists connections with app grouping metadata and serves the connect-oauth chooser without token values', async () => {
	const { get } = createHandler()

	const listResponse = await get()

	expect(listResponse.status).toBe(200)
	expect(mockModule.listJoinedIntegrations).toHaveBeenCalledWith(
		withEnv({ userId: ownerIdFromStored('stable-user-1') }),
	)
	expect(mockModule.listOauthApps).toHaveBeenCalledWith(
		withEnv({ userId: ownerIdFromStored('stable-user-1') }),
	)
	const listPayload = listResponse.data as {
		apps: Array<unknown>
		integrations: Array<unknown>
	}
	expect(listPayload).toMatchObject({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		savedPackages: [],
		approval: null,
	})
	expect(listPayload.apps).toHaveLength(2)
	expect(listPayload.apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug: 'github',
				clientId: 'github-client-id-value',
				connectionCount: 1,
				connections: [{ name: 'github', accountLabel: null }],
			}),
			expect.objectContaining({
				slug: 'google',
				clientId: 'shared-google-client',
				connectionCount: 2,
				connections: [
					{ name: 'google', accountLabel: 'Personal' },
					{ name: 'google-calendar', accountLabel: 'Work calendar' },
				],
			}),
		]),
	)
	expect(listPayload.integrations).toHaveLength(3)
	expect(listPayload.integrations).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'github',
				appSlug: 'github',
				clientId: 'github-client-id-value',
			}),
			expect.objectContaining({
				name: 'google',
				appSlug: 'google',
				clientId: 'shared-google-client',
				usageMode: 'any',
			}),
			expect.objectContaining({
				name: 'google-calendar',
				appSlug: 'google',
				clientId: 'shared-google-client',
			}),
		]),
	)
	// Secret *names* are fine in the payload; raw token values must never appear.
	expect(JSON.stringify(listPayload)).not.toMatch(tokenFields)

	const chooserResponse = await get('?connectChooser=1')
	expect(chooserResponse.status).toBe(200)
	const chooserPayload = chooserResponse.data as {
		ok: boolean
		chooser: { options: Array<unknown> }
	}
	expect(chooserPayload.ok).toBe(true)
	expect(chooserPayload.chooser.options).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'connection:google',
				kind: 'connection',
				href: '/connect/oauth?provider=google&app=google',
			}),
		]),
	)
	expect(JSON.stringify(chooserPayload)).not.toMatch(
		/secret-value|token-value/i,
	)
})

test('integrations API resolves named connections for connect OAuth, including missing and abandoned setup', async () => {
	const { get } = createHandler()

	const githubResponse = await get('?name=GitHub')
	expect(githubResponse.status).toBe(200)
	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith(
		withEnv({ userId: 'stable-user-1' as OwnerId, name: 'GitHub' }),
	)
	expect(githubResponse.data).toMatchObject({
		ok: true,
		builtInAvailable: false,
		existingConnection: { lane: 'user', appSlug: 'github' },
		hasStoredClientSecret: true,
		integration: {
			name: 'github',
			appSlug: 'github',
			clientId: 'github-client-id-value',
		},
	})

	mockModule.getJoinedIntegration.mockResolvedValueOnce(null as never)
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null as never)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce(null)
	const missingResponse = await get('?name=missing')
	expect(missingResponse.status).toBe(200)
	expect(missingResponse.data).toEqual({
		ok: true,
		builtInAvailable: false,
		existingConnection: null,
		hasStoredClientSecret: false,
		integration: null,
	})

	mockModule.getJoinedIntegration.mockResolvedValueOnce(null as never)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce({
		...mockModule.googleApp,
		slug: 'spotify',
		provider: 'spotify',
		clientId: 'spotify-client-from-setup',
		hasClientSecret: false,
		tokenUrl: 'https://accounts.spotify.com/api/token',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		deviceAuthorizationUrl: null,
		apiBaseUrl: null,
		extraAuthorizeParams: {},
	} as never)
	const abandonedResponse = await get('?name=spotify')
	expect(abandonedResponse.status).toBe(200)
	expect(abandonedResponse.data).toMatchObject({
		ok: true,
		integration: {
			name: 'spotify',
			appSlug: 'spotify',
			clientId: 'spotify-client-from-setup',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
			},
		},
	})
	expect(mockModule.findOauthAppForProviderSetup).toHaveBeenCalledWith(
		withEnv({ userId: 'stable-user-1' as OwnerId, name: 'spotify' }),
	)

	mockModule.getJoinedIntegration.mockResolvedValueOnce(null as never)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce({
		...mockModule.googleApp,
		hasClientSecret: false,
	} as never)
	const familyResponse = await get('?name=google-calendar')
	expect(familyResponse.status).toBe(200)
	const familyPayload = familyResponse.data
	expect(familyPayload).toMatchObject({
		ok: true,
		integration: {
			name: 'google-calendar',
			appSlug: 'google',
			clientId: 'shared-google-client',
			tokenUrl: 'https://oauth2.googleapis.com/token',
		},
	})
	expect(JSON.stringify(familyPayload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)
	expect(mockModule.findOauthAppForProviderSetup).toHaveBeenCalledWith(
		withEnv({
			userId: 'stable-user-1' as OwnerId,
			name: 'google-calendar',
		}),
	)
})

test('integrations API rotates OAuth app credentials with auth scoping and validation', async () => {
	const { post } = createHandler()
	const rotate = (body: Record<string, unknown>) =>
		post({
			action: 'rotate_oauth_app_credentials',
			appSlug: 'google',
			confirm: true,
			...body,
		})

	const rotateResponse = await rotate({
		clientId: 'shared-google-client-rotated',
		clientSecret: 'new-google-client-secret',
	})
	expect(rotateResponse.status).toBe(200)
	expect(mockModule.getOauthApp).toHaveBeenCalledWith(
		withEnv({ userId: 'stable-user-1' as OwnerId, slug: 'google' }),
	)
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1' as OwnerId,
			slug: 'google',
			value: 'new-google-client-secret',
		}),
	)
	expect(mockModule.rotateOauthAppClientCredentials).toHaveBeenCalledWith(
		withEnv({
			userId: 'stable-user-1' as OwnerId,
			slug: 'google',
			clientId: 'shared-google-client-rotated',
		}),
	)
	const rotatePayload = rotateResponse.data
	expect(rotatePayload).toMatchObject({
		ok: true,
		app: {
			slug: 'google',
			clientId: 'shared-google-client-rotated',
			hasClientSecret: true,
			connectionCount: 2,
			connections: [
				{ name: 'google', accountLabel: 'Personal' },
				{ name: 'google-calendar', accountLabel: 'Work calendar' },
			],
		},
	})
	expect(JSON.stringify(rotatePayload)).not.toMatch(
		/new-google-client-secret|"access_token"\s*:|"refresh_token"\s*:/,
	)

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'googleClientSecret',
			scope: 'user' as const,
			description: 'google OAuth client secret',
			packageId: null,
			allowedHosts: ['oauth2.googleapis.com', 'custom-package-api.example.com'],
			allowedPackages: [],
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
			expiresAt: null,
			ttlMs: null,
		},
	] as never)
	const mergeResponse = await rotate({ clientSecret: 'rotated-secret-value' })
	expect(mergeResponse.status).toBe(200)
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1' as OwnerId,
			slug: 'google',
			value: 'rotated-secret-value',
		}),
	)
	expect(JSON.stringify(mergeResponse.data)).not.toMatch(/rotated-secret-value/)

	// Rejections below must not reach the app lookup, rotation, or secret
	// writes beyond what the successful calls already made.
	mockModule.getOauthApp.mockResolvedValueOnce(null as never)
	const callCounts = () => [
		mockModule.getOauthApp.mock.calls.length,
		mockModule.rotateOauthAppClientCredentials.mock.calls.length,
		mockModule.saveSecret.mock.calls.length,
	]
	const beforeMissingApp = callCounts()
	const missingAppResponse = await rotate({
		appSlug: 'missing-app',
		clientSecret: 'secret-value',
	})
	expect(missingAppResponse.status).toBe(404)
	expect(missingAppResponse.data).toEqual({
		ok: false,
		error: 'OAuth app not found.',
	})
	expect(callCounts().slice(1)).toEqual(beforeMissingApp.slice(1))

	const beforeInvalid = callCounts()
	const invalidResponse = await rotate({ confirm: false })
	expect(invalidResponse.status).toBe(400)
	expect(invalidResponse.data).toEqual({
		ok: false,
		error: 'Invalid request body.',
	})
	expect(callCounts()).toEqual(beforeInvalid)

	const beforeUnauthorized = callCounts()
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	const unauthorizedResponse = await rotate({ clientSecret: 'secret-value' })
	expect(unauthorizedResponse.status).toBe(401)
	expect(callCounts()[1]).toBe(beforeUnauthorized[1])

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		sessionUserId: '99',
		userId: 99,
		username: 'other-user',
		email: 'other@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'other',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-other'),
			email: 'other@example.com',
			username: 'other-user',
			displayName: 'other',
		},
		request: sessionRequestContext('stable-user-other'),
	})
	const otherUserResponse = await rotate({
		clientId: 'other-client',
		clientSecret: 'other-secret',
	})
	expect(otherUserResponse.status).toBe(200)
	expect(mockModule.getOauthApp).toHaveBeenCalledWith(
		withEnv({ userId: ownerIdFromStored('stable-user-other'), slug: 'google' }),
	)
	expect(mockModule.rotateOauthAppClientCredentials).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-other'),
			slug: 'google',
		}),
	)
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('stable-user-other') }),
	)
})

test('integrations API disconnects a connection and deletes a user-lane OAuth app', async () => {
	const { post } = createHandler()
	const disconnectResponse = await post({
		action: 'disconnect_connection',
		name: 'google-calendar',
	})
	expect(disconnectResponse.status).toBe(200)
	expect(disconnectResponse.data).toEqual({
		ok: true,
		deleted: true,
	})
	expect(mockModule.deleteIntegration).toHaveBeenCalledWith(
		withEnv({
			userId: 'stable-user-1' as OwnerId,
			name: 'google-calendar',
		}),
	)

	mockModule.deleteIntegration.mockResolvedValueOnce(false)
	const missingDisconnect = await post({
		action: 'disconnect_connection',
		name: 'missing',
	})
	expect(missingDisconnect.status).toBe(404)

	const deleteAppResponse = await post({
		action: 'delete_oauth_app',
		appSlug: 'google',
	})
	expect(deleteAppResponse.status).toBe(200)
	expect(deleteAppResponse.data).toEqual({
		ok: true,
		deleted: true,
		connectionNames: ['google', 'google-calendar'],
	})
	expect(mockModule.getOauthApp).toHaveBeenCalledWith(
		withEnv({ userId: 'stable-user-1' as OwnerId, slug: 'google' }),
	)
	expect(mockModule.deleteOauthAppWithConnections).toHaveBeenCalledWith(
		withEnv({ userId: 'stable-user-1' as OwnerId, slug: 'google' }),
	)

	mockModule.getOauthApp.mockResolvedValueOnce(null as never)
	const missingApp = await post({
		action: 'delete_oauth_app',
		appSlug: 'missing',
	})
	expect(missingApp.status).toBe(404)
})

test('integrations API sets usage, returns approval payload, and grants a package without widening any', async () => {
	const { get, post } = createHandler()
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'pkg-mail',
			userId: 'stable-user-1' as OwnerId,
			name: 'mail',
			kodyId: 'mail',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-mail',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
		},
	] as never)

	const usageResponse = await post({
		action: 'set_usage',
		name: 'google',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})
	expect(usageResponse.status).toBe(200)
	expect(mockModule.setIntegrationUsage).toHaveBeenCalledWith(
		withEnv({
			userId: 'stable-user-1' as OwnerId,
			name: 'google',
			usageMode: 'packages',
			allowedPackageIds: ['pkg-mail'],
		}),
	)
	expect(usageResponse.data).toEqual({
		ok: true,
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})

	const approvalGet = await get('?name=google&package_id=pkg-mail')
	expect(approvalGet.status).toBe(200)
	const approvalPayload = approvalGet.data as {
		integration?: unknown
	}
	expect(approvalPayload).toMatchObject({
		ok: true,
		approval: {
			name: 'google',
			packageId: 'pkg-mail',
			packageKodyId: 'mail',
			usageMode: 'any',
			alreadyGranted: true,
		},
	})
	expect(approvalPayload.integration).toBeUndefined()

	mockModule.grantIntegrationPackage.mockResolvedValueOnce({
		name: 'google',
		usageMode: 'any',
		allowedPackageIds: [],
	} as never)
	const approveAny = await post({
		action: 'approve_package',
		name: 'google',
		packageId: 'pkg-mail',
	})
	expect(approveAny.status).toBe(200)
	expect(approveAny.data).toEqual({
		ok: true,
		alreadyGranted: true,
		usageMode: 'any',
		allowedPackageIds: [],
	})

	const missingPackage = await post({
		action: 'approve_package',
		name: 'google',
		packageId: 'pkg-missing',
	})
	expect(missingPackage.status).toBe(400)
})

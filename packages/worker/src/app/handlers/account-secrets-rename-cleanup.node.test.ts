import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as AllowedHosts from '#mcp/secrets/allowed-hosts.ts'
import type * as HostApproval from '#mcp/secrets/host-approval.ts'
import type * as secretsService from '#mcp/secrets/service.ts'
import type * as CredentialFields from '#worker/credentials/credential-fields.ts'
import type * as IntegrationsCredentials from '#worker/integrations/credentials.ts'
import type * as packageSubscriptions from '#worker/integrations/package-subscriptions.ts'
import type * as platformApps from '#worker/integrations/platform-apps.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
const mockModule = vi.hoisted(() => ({
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
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	})),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	saveSecret: vi.fn<typeof secretsService.saveSecret>(async () => ({
		name: 'githubAccessToken',
		scope: 'user',
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedPackages: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
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
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			expiresAt: null,
			ttlMs: null,
		}),
	),
	buildSecretHostApprovalUrl: vi.fn<
		typeof HostApproval.buildSecretHostApprovalUrl
	>(
		(input: { name: string; requestedHost: string }) =>
			`https://example.com/account/secrets/user/${input.name}?allowed-host=${input.requestedHost}`,
	),
	listSavedPackagesByUserId: vi.fn<
		typeof packageRepo.listSavedPackagesByUserId
	>(async () => []),
	listSecrets: vi.fn<typeof secretsService.listSecrets>(async () => []),
	listPackageSecretsByPackageIds: vi.fn<
		typeof secretsService.listPackageSecretsByPackageIds
	>(async () => new Map()),
	resolveSecret: vi.fn<typeof secretsService.resolveSecret>(async () => ({
		credentialId: null,
		found: false,
		value: null,
		scope: null,
		allowedHosts: [],
		allowedPackages: [],
	})),
	deleteSecret: vi.fn<typeof secretsService.deleteSecret>(async () => false),
	renameSecret: vi.fn<typeof secretsService.renameSecret>(async (input) => ({
		name: input.toName,
		scope: input.scope,
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedPackages: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		expiresAt: null,
		ttlMs: null,
	})),
	findSecret: vi.fn<typeof secretsService.findSecret>(async () => ({
		found: true,
		credentialId: 'cred-saved',
		scope: 'user',
		allowedHosts: [],
		allowedPackages: [],
	})),
	updateCredentialFields: vi.fn<typeof CredentialFields.updateCredentialFields>(
		async () => ({}) as never,
	),
	readStoredCredentialPlacement: vi.fn<
		typeof CredentialFields.readStoredCredentialPlacement
	>(async () => null),
	setSecretAllowedPackages: vi.fn<
		typeof secretsService.setSecretAllowedPackages
	>(async (input) => ({
		name: input.name,
		scope: input.scope,
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedPackages: input.allowedPackages,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		expiresAt: null,
		ttlMs: null,
	})),
	upsertIntegration: vi.fn<typeof IntegrationsService.upsertIntegration>(
		async (input) => ({
			...input.config,
			name: String(input.config.name).toLowerCase(),
		}),
	),
	upsertOauthAppWithoutConnection: vi.fn<
		typeof IntegrationsService.upsertOauthAppWithoutConnection
	>(async (input) => ({
		userId: ownerIdFromStored('stable-user-1'),
		slug: String(input.config.name).toLowerCase().replace(/\s+/g, '-'),
		provider:
			String(input.config.name)
				.toLowerCase()
				.replace(/\s+/g, '-')
				.split('-')[0] ?? '',
		label: null,
		clientId: input.config.clientId,
		hasClientSecret: false,
		tokenUrl: input.config.tokenUrl,
		authorizeUrl: null,
		deviceAuthorizationUrl: null,
		apiBaseUrl: input.config.apiBaseUrl ?? null,
		flow: input.config.flow,
		usePkce: input.config.usePkce ?? null,
		tokenExchangeStyle: input.config.tokenExchangeStyle ?? null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	getAvailablePlatformApp: vi.fn<
		typeof IntegrationsService.getAvailablePlatformApp
	>(async () => null),
	upsertPlatformIntegration: vi.fn<
		typeof IntegrationsService.upsertPlatformIntegration
	>(async (input) => ({
		name: String(input.name ?? input.platformAppSlug).toLowerCase(),
		tokenUrl: 'https://example.com/oauth/token',
		flow: 'confidential',
		clientId: 'platform-client-id',
		platform: true,
	})),
	getPlatformOauthAppClientSecret: vi.fn<
		typeof platformApps.getPlatformOauthAppClientSecret
	>(async () => null),
	dispatchIntegrationAuthSucceededSubscriptionEvents: vi.fn<
		typeof packageSubscriptions.dispatchIntegrationAuthSucceededSubscriptionEvents
	>(async () => []),
	persistIntegrationTokens: vi.fn<
		typeof IntegrationsCredentials.persistIntegrationTokens
	>(async () => undefined),
	persistUserOauthAppClientSecret: vi.fn<
		typeof IntegrationsCredentials.persistUserOauthAppClientSecret
	>(async () => undefined),
	resolveUserOauthAppClientSecret: vi.fn<
		typeof IntegrationsCredentials.resolveUserOauthAppClientSecret
	>(async () => null),
	getOauthApp: vi.fn<typeof IntegrationsService.getOauthApp>(async () => null),
	findOauthAppForProviderSetup: vi.fn<
		typeof IntegrationsService.findOauthAppForProviderSetup
	>(async () => null),
	getJoinedIntegration: vi.fn<typeof IntegrationsService.getJoinedIntegration>(
		async (input) => {
			const name = String(input.name).toLowerCase()
			return {
				lane: 'user',
				app: {
					userId: ownerIdFromStored('stable-user-1'),
					slug: name,
					provider: name,
					label: null,
					clientId: `${name}-client-id`,
					hasClientSecret: false,
					tokenUrl: 'https://example.com/oauth/token',
					authorizeUrl: null,
					deviceAuthorizationUrl: null,
					apiBaseUrl: null,
					flow: 'pkce',
					usePkce: null,
					tokenExchangeStyle: null,
					scopeSeparator: null,
					extraAuthorizeParams: {},
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				},
				connection: {
					userId: ownerIdFromStored('stable-user-1'),
					credentialId: 'cred-integration',
					name,
					appSlug: name,
					platformAppSlug: null,
					accountLabel: null,
					description: '',
					scopes: [],
					requiredHosts: [],
					usageMode: 'any',
					allowedPackageIds: [],
					connectedAt: null,
					tokenRefreshedAt: null,
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				},
			}
		},
	),
}))

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

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#mcp/secrets/allowed-hosts.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AllowedHosts>()
	return {
		normalizeAllowedHosts: actual.normalizeAllowedHosts,
		normalizeHost: actual.normalizeHost,
	}
})

vi.mock('#mcp/secrets/host-approval.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof HostApproval>()
	return {
		...actual,
		buildSecretHostApprovalUrl: (
			...args: Parameters<typeof HostApproval.buildSecretHostApprovalUrl>
		) => mockModule.buildSecretHostApprovalUrl(...args),
	}
})

vi.mock('#mcp/secrets/service.ts', () => ({
	saveSecret: (...args: Parameters<typeof secretsService.saveSecret>) =>
		mockModule.saveSecret(...args),
	setSecretAllowedHosts: (
		...args: Parameters<typeof secretsService.setSecretAllowedHosts>
	) => mockModule.setSecretAllowedHosts(...args),
	listSecrets: (...args: Parameters<typeof secretsService.listSecrets>) =>
		mockModule.listSecrets(...args),
	listPackageSecretsByPackageIds: (
		...args: Parameters<typeof secretsService.listPackageSecretsByPackageIds>
	) => mockModule.listPackageSecretsByPackageIds(...args),
	resolveSecret: (...args: Parameters<typeof secretsService.resolveSecret>) =>
		mockModule.resolveSecret(...args),
	deleteSecret: (...args: Parameters<typeof secretsService.deleteSecret>) =>
		mockModule.deleteSecret(...args),
	renameSecret: (...args: Parameters<typeof secretsService.renameSecret>) =>
		mockModule.renameSecret(...args),
	findSecret: (...args: Parameters<typeof secretsService.findSecret>) =>
		mockModule.findSecret(...args),
	setSecretAllowedPackages: (
		...args: Parameters<typeof secretsService.setSecretAllowedPackages>
	) => mockModule.setSecretAllowedPackages(...args),
}))

vi.mock('#worker/credentials/credential-fields.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CredentialFields>()
	return {
		...actual,
		updateCredentialFields: (
			...args: Parameters<typeof CredentialFields.updateCredentialFields>
		) => mockModule.updateCredentialFields(...args),
		readStoredCredentialPlacement: (
			...args: Parameters<typeof CredentialFields.readStoredCredentialPlacement>
		) => mockModule.readStoredCredentialPlacement(...args),
	}
})

vi.mock('#worker/orgs/org-audit.ts', () => ({
	orgAuditWriterFromRequest: () => ({ audit: 'writer' }),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsService>()
	return {
		upsertIntegration: (
			...args: Parameters<typeof IntegrationsService.upsertIntegration>
		) => mockModule.upsertIntegration(...args),
		upsertOauthAppWithoutConnection: (
			...args: Parameters<
				typeof IntegrationsService.upsertOauthAppWithoutConnection
			>
		) => mockModule.upsertOauthAppWithoutConnection(...args),
		getAvailablePlatformApp: (
			...args: Parameters<typeof IntegrationsService.getAvailablePlatformApp>
		) => mockModule.getAvailablePlatformApp(...args),
		upsertPlatformIntegration: (
			...args: Parameters<typeof IntegrationsService.upsertPlatformIntegration>
		) => mockModule.upsertPlatformIntegration(...args),
		getJoinedIntegration: (
			...args: Parameters<typeof IntegrationsService.getJoinedIntegration>
		) => mockModule.getJoinedIntegration(...args),
		getOauthApp: (
			...args: Parameters<typeof IntegrationsService.getOauthApp>
		) => mockModule.getOauthApp(...args),
		findOauthAppForProviderSetup: (
			...args: Parameters<
				typeof IntegrationsService.findOauthAppForProviderSetup
			>
		) => mockModule.findOauthAppForProviderSetup(...args),
		// Real scope validation so handler ordering tests exercise the actual
		// allowlist semantics.
		assertScopesAllowedForPlatformApp: actual.assertScopesAllowedForPlatformApp,
	}
})

vi.mock('#worker/integrations/package-subscriptions.ts', () => ({
	dispatchIntegrationAuthSucceededSubscriptionEvents: (
		...args: Parameters<
			typeof packageSubscriptions.dispatchIntegrationAuthSucceededSubscriptionEvents
		>
	) => mockModule.dispatchIntegrationAuthSucceededSubscriptionEvents(...args),
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn(async () => []),
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))

vi.mock('#worker/integrations/platform-apps.ts', () => ({
	getPlatformOauthAppClientSecret: (
		...args: Parameters<typeof platformApps.getPlatformOauthAppClientSecret>
	) => mockModule.getPlatformOauthAppClientSecret(...args),
}))

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsCredentials>()
	return {
		...actual,
		persistIntegrationTokens: (
			...args: Parameters<
				typeof IntegrationsCredentials.persistIntegrationTokens
			>
		) => mockModule.persistIntegrationTokens(...args),
		persistUserOauthAppClientSecret: (
			...args: Parameters<
				typeof IntegrationsCredentials.persistUserOauthAppClientSecret
			>
		) => mockModule.persistUserOauthAppClientSecret(...args),
		resolveUserOauthAppClientSecret: (
			...args: Parameters<
				typeof IntegrationsCredentials.resolveUserOauthAppClientSecret
			>
		) => mockModule.resolveUserOauthAppClientSecret(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

const { testAccountSecretsApiHandler } =
	await import('./account-secrets.test-support.ts')

const secretsUrl = 'https://example.com/account/secrets.json'
const epoch = new Date(0).toISOString()

function createHandler() {
	const { execute } = testAccountSecretsApiHandler({
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env)
	return (request: Request) => execute({ request, params: {} } as never)
}

function postRequest(body: Record<string, unknown>, search = '') {
	return new Request(`${secretsUrl}${search}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function makeSecret(name: string, overrides: Record<string, unknown> = {}) {
	return {
		credentialId: `cred-${name}`,
		name,
		scope: 'user' as const,
		description: '',
		packageId: null,
		allowedHosts: [] as Array<string>,
		allowedPackages: [] as Array<string>,
		createdAt: epoch,
		updatedAt: epoch,
		expiresAt: null,
		ttlMs: null,
		...overrides,
	}
}

test('account secrets save reports rename cleanup failure without failing the save', async () => {
	// Scope move still uses create-under-new + delete-old; same-scope renames
	// update the row in place and never hit this cleanup path.
	const existing = makeSecret('oldApiKey')
	const pkg = {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: '',
		tags: [] as Array<string>,
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: epoch,
		updatedAt: epoch,
	}
	mockModule.listSavedPackagesByUserId.mockResolvedValue([pkg] as never)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
	mockModule.listSecrets
		.mockResolvedValueOnce([existing])
		.mockResolvedValueOnce([
			makeSecret('oldApiKey', { scope: 'package', packageId: 'pkg-1' }),
		])
	mockModule.saveSecret.mockResolvedValueOnce({
		name: 'oldApiKey',
		scope: 'package',
		description: '',
		packageId: 'pkg-1',
		allowedHosts: [],
		allowedPackages: [],
		createdAt: epoch,
		updatedAt: epoch,
		expiresAt: null,
		ttlMs: null,
	} as never)
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'fresh-secret',
	} as never)
	mockModule.deleteSecret.mockRejectedValueOnce(
		new Error('delete prior secret failed'),
	)

	const call = createHandler()
	const response = await call(
		postRequest({
			action: 'save',
			currentId: 'user::::oldApiKey',
			name: 'oldApiKey',
			scope: 'package',
			packageId: 'pkg-1',
			value: 'fresh-secret',
			allowedHosts: [],
			allowedPackages: [],
		}),
	)

	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		renameCleanupError: 'delete prior secret failed',
		selectedSecret: { name: 'oldApiKey', scope: 'package' },
	})
	expect(mockModule.renameSecret).not.toHaveBeenCalled()
	expect(mockModule.deleteSecret).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'oldApiKey', scope: 'user' }),
	)
})

function mockSecretsListing(secrets: Array<unknown>) {
	mockModule.listSecrets.mockResolvedValue(secrets as never)
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
}

test('account secrets save renames opt-in credentials in place without their kind, including case-only', async () => {
	const placement = {
		id: 'cred-webhook',
		kind: 'url' as const,
		allowedHosts: ['hooks.example.com'],
		loginExchange: null,
		provider: null,
		inject: {
			kind: 'header' as const,
			name: 'Authorization',
			format: 'Bearer {value}',
		},
		placement: null,
	}
	const save = (body: Record<string, unknown>) =>
		createHandler()(
			postRequest({
				action: 'save',
				currentId: 'user::::webhook',
				scope: 'user',
				value: 'https://hooks.example.com/new',
				allowedPackages: [],
				...body,
			}),
		)

	mockSecretsListing([makeSecret('webhook')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.saveSecret.mockClear()
	mockModule.renameSecret.mockClear()
	const renamed = await save({ name: 'webhook2', allowedHosts: [] })
	expect(renamed.status).toBe(200)
	expect(mockModule.renameSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			fromName: 'webhook',
			toName: 'webhook2',
			scope: 'user',
		}),
	)
	expect(mockModule.deleteSecret).not.toHaveBeenCalled()
	// Placement is read under the prior name before the in-place rename commits.
	expect(mockModule.readStoredCredentialPlacement.mock.lastCall?.[0].name).toBe(
		'webhook',
	)

	mockSecretsListing([makeSecret('Henry')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.renameSecret.mockClear()
	const caseOnly = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::Henry',
			name: 'henry',
			scope: 'user',
			value: 'https://hooks.example.com/new',
			allowedHosts: [],
			allowedPackages: [],
		}),
	)
	expect(caseOnly.status).toBe(200)
	expect(mockModule.renameSecret).toHaveBeenCalledWith(
		expect.objectContaining({ fromName: 'Henry', toName: 'henry' }),
	)
	expect(caseOnly.data).toMatchObject({
		ok: true,
		selectedSecret: { name: 'henry', id: 'user::::henry' },
	})

	mockSecretsListing([makeSecret('webhook')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.saveSecret.mockClear()
	mockModule.renameSecret.mockClear()
	const rehosted = await save({
		name: 'webhook',
		allowedHosts: ['other.example.com'],
	})
	expect(rehosted.status).toBe(400)
	expect(rehosted.data).toMatchObject({
		error: expect.stringContaining('take hosts, not approved hosts'),
	})
	expect(mockModule.saveSecret).not.toHaveBeenCalled()
	expect(mockModule.renameSecret).not.toHaveBeenCalled()

	mockSecretsListing([makeSecret('Henry')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.renameSecret.mockClear()
	const rejectedBeforeRename = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::Henry',
			name: 'henry',
			scope: 'user',
			value: 'https://hooks.example.com/new',
			allowedHosts: ['other.example.com'],
			allowedPackages: [],
		}),
	)
	expect(rejectedBeforeRename.status).toBe(400)
	expect(mockModule.renameSecret).not.toHaveBeenCalled()

	mockSecretsListing([makeSecret('webhook')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	const unchanged = await save({
		name: 'webhook',
		allowedHosts: ['HOOKS.example.com'],
	})
	expect(unchanged.status).toBe(200)
})

test('account secrets save rolls back an in-place rename when the later write fails', async () => {
	const placement = {
		id: 'cred-webhook',
		kind: 'url' as const,
		allowedHosts: ['hooks.example.com'],
		loginExchange: null,
		provider: null,
		inject: {
			kind: 'header' as const,
			name: 'Authorization',
			format: 'Bearer {value}',
		},
		placement: null,
	}
	mockSecretsListing([makeSecret('Henry')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.renameSecret.mockClear()
	mockModule.saveSecret.mockRejectedValueOnce(new Error('value write failed'))

	const response = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::Henry',
			name: 'henry',
			scope: 'user',
			value: 'https://hooks.example.com/new',
			allowedHosts: [],
			allowedPackages: [],
		}),
	)
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({
		ok: false,
		error: 'value write failed',
	})
	expect(mockModule.renameSecret.mock.calls.map((call) => call[0])).toEqual([
		expect.objectContaining({ fromName: 'Henry', toName: 'henry' }),
		expect.objectContaining({ fromName: 'henry', toName: 'Henry' }),
	])
})

test('account secrets save still refuses moving an opt-in credential across scopes without its kind', async () => {
	const placement = {
		id: 'cred-webhook',
		kind: 'url' as const,
		allowedHosts: ['hooks.example.com'],
		loginExchange: null,
		provider: null,
		inject: {
			kind: 'header' as const,
			name: 'Authorization',
			format: 'Bearer {value}',
		},
		placement: null,
	}
	const pkg = {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: '',
		tags: [] as Array<string>,
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: epoch,
		updatedAt: epoch,
	}
	mockModule.listSavedPackagesByUserId.mockResolvedValue([pkg] as never)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
	mockModule.listSecrets.mockResolvedValue([makeSecret('webhook')] as never)
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce(placement)
	mockModule.renameSecret.mockClear()
	mockModule.saveSecret.mockClear()

	const moved = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::webhook',
			name: 'webhook',
			scope: 'package',
			packageId: 'pkg-1',
			value: 'https://hooks.example.com/new',
			allowedHosts: [],
			allowedPackages: [],
		}),
	)
	expect(moved.status).toBe(400)
	expect(moved.data).toMatchObject({
		error: expect.stringContaining('would drop its kind'),
	})
	expect(mockModule.renameSecret).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).not.toHaveBeenCalled()
})

test('a failed rollback reports the committed casing so native editors can retarget without retrying a create', async () => {
	mockSecretsListing([makeSecret('Henry')])
	mockModule.readStoredCredentialPlacement.mockResolvedValueOnce({
		id: 'cred-Henry',
		kind: 'url',
		allowedHosts: ['hooks.example.com'],
		loginExchange: null,
		provider: null,
		inject: { kind: 'header', name: 'Authorization', format: 'Bearer {value}' },
		placement: null,
	})
	mockModule.renameSecret
		.mockResolvedValueOnce(makeSecret('henry') as never)
		.mockRejectedValueOnce(new Error('rollback unavailable'))
	mockModule.saveSecret.mockRejectedValueOnce(new Error('value write failed'))
	const response = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::Henry',
			name: 'henry',
			scope: 'user',
			value: 'https://hooks.example.com/new',
			allowedHosts: [],
			allowedPackages: [],
		}),
	)
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({
		ok: false,
		error: 'value write failed',
		selectedSecret: { id: 'user::::henry', name: 'henry' },
	})
	expect(response.data).not.toHaveProperty('secrets')
})

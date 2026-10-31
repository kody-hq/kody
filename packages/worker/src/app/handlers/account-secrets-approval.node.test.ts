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
		placement: null,
		disconnected: false,
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
			placement: null,
			disconnected: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			expiresAt: null,
			ttlMs: null,
		}),
	),
	setSecretsAllowedHosts: vi.fn<typeof secretsService.setSecretsAllowedHosts>(
		async (input) =>
			input.updates.map((update) => ({
				name: update.name,
				scope: input.scope,
				description: '',
				packageId: null,
				allowedHosts: update.allowedHosts,
				allowedPackages: [],
				placement: null,
				disconnected: false,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				expiresAt: null,
				ttlMs: null,
			})),
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
		placement: null,
	})),
	deleteSecret: vi.fn<typeof secretsService.deleteSecret>(async () => false),
	renameSecret: vi.fn<typeof secretsService.renameSecret>(async (input) => ({
		name: input.toName,
		scope: input.scope,
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedPackages: [],
		placement: null,
		disconnected: false,
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
		placement: null,
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
		placement: null,
		disconnected: false,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		expiresAt: null,
		ttlMs: null,
	})),
	setSecretsAllowedPackages: vi.fn<
		typeof secretsService.setSecretsAllowedPackages
	>(async (input) =>
		input.updates.map((update) => ({
			name: update.name,
			scope: input.scope,
			description: '',
			packageId: null,
			allowedHosts: [],
			allowedPackages: update.allowedPackages,
			placement: null,
			disconnected: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			expiresAt: null,
			ttlMs: null,
		})),
	),
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
	setSecretsAllowedHosts: (
		...args: Parameters<typeof secretsService.setSecretsAllowedHosts>
	) => mockModule.setSecretsAllowedHosts(...args),
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
	setSecretsAllowedPackages: (
		...args: Parameters<typeof secretsService.setSecretsAllowedPackages>
	) => mockModule.setSecretsAllowedPackages(...args),
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
	recordOrgAuditEvent: async () => {},
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
const userStorage = { sessionId: null, appId: null, packageId: null }

function createHandler() {
	const { execute } = testAccountSecretsApiHandler({
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env)
	return (request: Request) => execute({ request, params: {} } as never)
}

function getRequest(search: string) {
	return new Request(`${secretsUrl}${search}`, { method: 'GET' })
}

function postRequest(body: Record<string, unknown>, search = '') {
	return new Request(`${secretsUrl}${search}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

const approve = (search: string) => postRequest({ action: 'approve' }, search)

function makeSecret(name: string, overrides: Record<string, unknown> = {}) {
	return {
		credentialId: `cred-${name}`,
		name,
		scope: 'user' as const,
		description: '',
		packageId: null,
		allowedHosts: [] as Array<string>,
		allowedPackages: [] as Array<string>,
		placement: null,
		disconnected: false,
		createdAt: epoch,
		updatedAt: epoch,
		expiresAt: null,
		ttlMs: null,
		...overrides,
	}
}

function mockSecretsListing(secrets: Array<unknown>) {
	mockModule.listSecrets.mockResolvedValue(secrets as never)
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
}
test('host approval view and approve persist normalized hosts for the selected secret', async () => {
	const cloudflareToken = makeSecret('cloudflareToken', {
		description: 'Cloudflare token',
	})
	mockModule.listSecrets.mockResolvedValueOnce([cloudflareToken] as never)
	mockModule.listSecrets.mockResolvedValueOnce([cloudflareToken] as never)

	const call = createHandler()
	const selected =
		'?selected=user::::cloudflareToken&allowed-host=API.Cloudflare.com'
	const viewResponse = await call(getRequest(selected))

	expect(viewResponse.status).toBe(200)
	expect(viewResponse.data).toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'api.cloudflare.com',
			requestedPackageId: null,
			currentAllowedHosts: [],
		},
	})

	mockModule.listSecrets.mockResolvedValueOnce([
		{ ...cloudflareToken, allowedHosts: ['api.github.com'] },
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await call(approve(selected))

	expect(approveResponse.status).toBe(200)
	expect(approveResponse.data).toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedHosts: ['api.cloudflare.com', 'api.github.com'],
			storageContext: userStorage,
		}),
	)
})

test('host bulk approval adds every requested host to each listed secret', async () => {
	mockSecretsListing([
		makeSecret('cloudflareToken', { allowedHosts: ['api.github.com'] }),
		makeSecret('openaiApiKey'),
	])

	const call = createHandler()
	const bulk =
		'?names=cloudflareToken,openaiApiKey&hosts=api.cloudflare.com,dash.cloudflare.com'
	const viewResponse = await call(getRequest(bulk))
	expect(viewResponse.status).toBe(200)
	expect(viewResponse.data).toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			names: ['cloudflareToken', 'openaiApiKey'],
			requestedHost: 'api.cloudflare.com',
			requestedHosts: ['api.cloudflare.com', 'dash.cloudflare.com'],
			requestedPackageId: null,
		},
	})

	const approveResponse = await call(approve(bulk))
	expect(approveResponse.status).toBe(200)
	expect(approveResponse.data).toMatchObject({ ok: true })
	expect(mockModule.setSecretsAllowedHosts).toHaveBeenCalledTimes(1)
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'user',
			updates: [
				{
					name: 'cloudflareToken',
					allowedHosts: [
						'api.cloudflare.com',
						'api.github.com',
						'dash.cloudflare.com',
					],
				},
				{
					name: 'openaiApiKey',
					allowedHosts: ['api.cloudflare.com', 'dash.cloudflare.com'],
				},
			],
		}),
	)
})

test('host approval rejects truncated and malformed hosts instead of writing them', async () => {
	mockSecretsListing([makeSecret('openaiApiKey')])

	const call = createHandler()
	const mixed = '?names=openaiApiKey&hosts=hooks.slack.com,api.ope'
	const mixedView = await call(getRequest(mixed))
	expect(mixedView.status).toBe(200)
	expect(mixedView.data).toMatchObject({
		ok: true,
		approval: {
			name: 'openaiApiKey',
			names: ['openaiApiKey'],
			requestedHost: 'hooks.slack.com',
			requestedHosts: ['hooks.slack.com'],
			rejectedHosts: [{ host: 'api.ope', reason: 'unknown_suffix' }],
		},
	})

	const mixedApprove = await call(approve(mixed))
	expect(mixedApprove.status).toBe(200)
	expect(mixedApprove.data).toMatchObject({
		ok: true,
		action: 'approve',
		approvalKind: 'host_bulk',
	})
	expect(mockModule.setSecretsAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'user',
			updates: [{ name: 'openaiApiKey', allowedHosts: ['hooks.slack.com'] }],
		}),
	)

	mockModule.setSecretsAllowedHosts.mockClear()
	const invalidOnlyView = await call(
		getRequest('?names=openaiApiKey&hosts=api.openai.com/v1,%20%20,api.ope'),
	)
	expect(invalidOnlyView.status).toBe(200)
	expect(invalidOnlyView.data).toMatchObject({
		ok: true,
		approval: {
			requestedHosts: [],
			rejectedHosts: [
				{ host: 'api.ope', reason: 'unknown_suffix' },
				{ host: 'api.openai.com/v1', reason: 'malformed' },
			],
		},
	})

	const invalidOnlyApprove = await call(
		approve('?names=openaiApiKey&hosts=api.ope'),
	)
	expect(invalidOnlyApprove.status).toBe(400)
	expect(invalidOnlyApprove.data).toMatchObject({
		ok: false,
		error:
			'None of the requested hosts are valid. The approval link may have been truncated — copy it again.',
	})
	expect(mockModule.setSecretsAllowedHosts).not.toHaveBeenCalled()
})

test('approval requests reject invalid targets and ignore stale capability query params', async () => {
	const call = createHandler()
	const selected = '?selected=user::::cloudflareToken'

	const rejected: Array<[string, string]> = [
		[
			`${selected}&allowed-host=api.cloudflare.com&package_id=pkg-123`,
			'Approval request contains both host and package.',
		],
		[selected, 'Approval request is missing a host or package.'],
		[
			`${selected}&capability=secretSet`,
			'Approval request is missing a host or package.',
		],
	]
	for (const [search, error] of rejected) {
		const response = await call(approve(search))
		expect(response.status).toBe(400)
		expect(response.data).toMatchObject({ ok: false, error })
	}
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedPackages).not.toHaveBeenCalled()

	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())
	const staleCapabilityView = await call(
		getRequest(`${selected}&capability=secretSet`),
	)
	expect(staleCapabilityView.status).toBe(200)
	expect(staleCapabilityView.data).toMatchObject({
		ok: true,
		approval: null,
		approvalError: null,
	})
})

test('account secrets payload includes all packages and package titles and allowed packages', async () => {
	const makePackage = (id: string, kodyId: string, hasApp: boolean) => ({
		id,
		userId: ownerIdFromStored('stable-user-1'),
		name: `@kentcdodds/${kodyId}`,
		kodyId,
		description: kodyId,
		tags: ['discord'],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: epoch,
		updatedAt: epoch,
	})
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		makePackage('package-123', 'discord-gateway', true),
		makePackage('pkg-allowed', 'discord-general-chat', false),
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('discordBotToken', { allowedPackages: ['pkg-allowed'] }),
	] as never)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(
		new Map([
			[
				'package-123',
				[
					makeSecret('gatewaySigningSecret', {
						scope: 'package',
						packageId: 'package-123',
					}),
				],
			],
		]) as never,
	)

	const response = await createHandler()(getRequest(''))

	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		secrets: expect.arrayContaining([
			expect.objectContaining({
				name: 'discordBotToken',
				scope: 'user',
				allowedPackages: ['pkg-allowed'],
			}),
			expect.objectContaining({
				name: 'gatewaySigningSecret',
				scope: 'package',
				packageTitle: '@kentcdodds/discord-gateway',
			}),
		]),
	})
})

test('package approval reject and approve handle missing secrets and deduplicate package ids', async () => {
	const call = createHandler()
	const savedPackages = ['allowed', 'new'].map((suffix) => ({
		id: `pkg-${suffix}`,
		kodyId: `${suffix}-pkg`,
		name: `@user/${suffix}-pkg`,
		updatedAt: epoch,
	}))

	const rejectResponse = await call(
		postRequest(
			{ action: 'reject' },
			'?selected=user::::discordBotToken&package_id=pkg-allowed',
		),
	)

	expect(rejectResponse.status).toBe(200)
	expect(rejectResponse.data).toEqual({
		ok: true,
		action: 'reject',
		approvalKind: 'package',
	})
	expect(mockModule.listSecrets).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedPackages).not.toHaveBeenCalled()

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(
		savedPackages as never,
	)
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('discordBotToken', {
			allowedPackages: ['pkg-allowed', 'pkg-allowed'],
		}),
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(
		savedPackages as never,
	)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await call(
		approve('?selected=user::::discordBotToken&package_id=pkg-new'),
	)

	expect(approveResponse.status).toBe(200)
	expect(approveResponse.data).toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'discordBotToken',
			scope: 'user',
			allowedPackages: ['pkg-allowed', 'pkg-new'],
		}),
	)
})

test('bulk package approval view and approve grant the package on every listed secret', async () => {
	const call = createHandler()
	mockSecretsListing([
		makeSecret('discordBotToken'),
		makeSecret('xAccessToken'),
		makeSecret('githubAccessToken', { allowedPackages: ['pkg-release'] }),
	])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'pkg-release',
			kodyId: 'release',
			name: '@kentcdodds/release',
			updatedAt: epoch,
		},
	] as never)
	const bulk =
		'?package_id=pkg-release&names=discordBotToken,xAccessToken,githubAccessToken'

	const viewResponse = await call(getRequest(bulk))

	expect(viewResponse.status).toBe(200)
	expect(viewResponse.data).toMatchObject({
		ok: true,
		approval: {
			names: ['discordBotToken', 'xAccessToken'],
			requestedPackageId: 'pkg-release',
			scope: 'user',
		},
	})

	const approveResponse = await call(approve(bulk))

	expect(approveResponse.status).toBe(200)
	expect(approveResponse.data).toMatchObject({ ok: true })
	expect(mockModule.setSecretsAllowedPackages).toHaveBeenCalledTimes(1)
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()
	expect(mockModule.setSecretsAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'user',
			updates: [
				{ name: 'discordBotToken', allowedPackages: ['pkg-release'] },
				{ name: 'xAccessToken', allowedPackages: ['pkg-release'] },
			],
		}),
	)
})

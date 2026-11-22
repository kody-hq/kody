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
const credentialAuditCalls = vi.hoisted(() => ({
	record: vi.fn(async (_writer: unknown, _change: unknown) => {}),
}))

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
	disconnectSecret: vi.fn<typeof secretsService.disconnectSecret>(
		async () => false,
	),
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
	readAuthenticatedAppUser: mockModule.readAuthenticatedAppUser,
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
		buildSecretHostApprovalUrl: mockModule.buildSecretHostApprovalUrl,
	}
})

vi.mock('#mcp/secrets/service.ts', () => ({
	saveSecret: mockModule.saveSecret,
	setSecretAllowedHosts: mockModule.setSecretAllowedHosts,
	setSecretsAllowedHosts: mockModule.setSecretsAllowedHosts,
	listSecrets: mockModule.listSecrets,
	listPackageSecretsByPackageIds: mockModule.listPackageSecretsByPackageIds,
	resolveSecret: mockModule.resolveSecret,
	deleteSecret: mockModule.deleteSecret,
	disconnectSecret: mockModule.disconnectSecret,
	renameSecret: mockModule.renameSecret,
	findSecret: mockModule.findSecret,
	setSecretAllowedPackages: mockModule.setSecretAllowedPackages,
	setSecretsAllowedPackages: mockModule.setSecretsAllowedPackages,
}))

vi.mock('#worker/credentials/credential-fields.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CredentialFields>()
	return {
		...actual,
		updateCredentialFields: mockModule.updateCredentialFields,
		readStoredCredentialPlacement: mockModule.readStoredCredentialPlacement,
	}
})

vi.mock('#worker/orgs/org-audit.ts', () => ({
	orgAuditWriterFromRequest: () => ({ audit: 'writer' }),
	recordOrgAuditEvent: async () => {},
}))

vi.mock('#worker/credentials/credential-audit.ts', () => ({
	credentialAuditActions: { renamed: 'credential.renamed' },
	recordCredentialAudit: credentialAuditCalls.record,
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsService>()
	return {
		upsertIntegration: mockModule.upsertIntegration,
		upsertOauthAppWithoutConnection: mockModule.upsertOauthAppWithoutConnection,
		getAvailablePlatformApp: mockModule.getAvailablePlatformApp,
		upsertPlatformIntegration: mockModule.upsertPlatformIntegration,
		getJoinedIntegration: mockModule.getJoinedIntegration,
		getOauthApp: mockModule.getOauthApp,
		findOauthAppForProviderSetup: mockModule.findOauthAppForProviderSetup,
		// Real scope validation so handler ordering tests exercise the actual
		// allowlist semantics.
		assertScopesAllowedForPlatformApp: actual.assertScopesAllowedForPlatformApp,
	}
})

vi.mock('#worker/integrations/package-subscriptions.ts', () => ({
	dispatchIntegrationAuthSucceededSubscriptionEvents:
		mockModule.dispatchIntegrationAuthSucceededSubscriptionEvents,
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn(async () => []),
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))

vi.mock('#worker/integrations/platform-apps.ts', () => ({
	getPlatformOauthAppClientSecret: mockModule.getPlatformOauthAppClientSecret,
}))

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsCredentials>()
	return {
		...actual,
		persistIntegrationTokens: mockModule.persistIntegrationTokens,
		persistUserOauthAppClientSecret: mockModule.persistUserOauthAppClientSecret,
		resolveUserOauthAppClientSecret: mockModule.resolveUserOauthAppClientSecret,
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mockModule.listSavedPackagesByUserId,
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
		placement: null,
		disconnected: false,
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
			placement: null,
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
	credentialAuditCalls.record.mockClear()
	const renamed = await save({ name: 'webhook2', allowedHosts: [] })
	expect(renamed.status).toBe(200)
	// The provisional rename writes no audit row; one row after the save.
	expect(mockModule.renameSecret).toHaveBeenCalledWith(
		expect.objectContaining({ audit: null }),
	)
	expect(credentialAuditCalls.record).toHaveBeenCalledTimes(1)
	expect(credentialAuditCalls.record.mock.lastCall?.[1]).toMatchObject({
		action: 'credential.renamed',
		details: { previousName: 'webhook', fields: ['name'] },
	})
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
			placement: null,
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
			placement: null,
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
			placement: null,
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

test('account secrets save refuses renaming to a name a placeholder cannot reference', async () => {
	mockSecretsListing([makeSecret('Henry')])
	mockModule.renameSecret.mockClear()

	const response = await createHandler()(
		postRequest({
			action: 'save',
			currentId: 'user::::Henry',
			name: 'Henry Ford',
			scope: 'user',
			value: 'new value',
			allowedHosts: [],
			allowedPackages: [],
			placement: null,
		}),
	)
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({
		ok: false,
		error: expect.stringMatching(/not a valid secret name/),
	})
	expect(mockModule.renameSecret).not.toHaveBeenCalled()
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
			placement: null,
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
			placement: null,
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

test('account secrets disconnect clears the value and keeps the record', async () => {
	const userStorage = { sessionId: null, appId: null, packageId: null }
	mockModule.disconnectSecret.mockResolvedValueOnce(true)
	const response = await createHandler()(
		postRequest({ action: 'disconnect', currentId: 'user::::myApiKey' }),
	)
	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		disconnected: true,
		secretId: 'user::::myApiKey',
	})
	expect(mockModule.disconnectSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			name: 'myApiKey',
			scope: 'user',
			storageContext: userStorage,
		}),
	)
	expect(mockModule.deleteSecret).not.toHaveBeenCalled()
})
